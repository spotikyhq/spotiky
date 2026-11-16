// Spotiky Worker. Runs on Cloudflare Workers, not GitHub Pages.
// Live at https://spotiky-preview.spotikyhq.workers.dev
//
//   GET  /?id=TRACK_ID     a track's preview MP3 and song name: { preview_url, name, source }
//   GET  /codes?c=夜光,𓇰𓇶   what each Spotiky code stands for: { "夜光": {type, id, ...}, "𓇰𓇶": null }
//   POST /suggest          { type: "track", id } or { type: "playlist", items } -> code suggestions
//   POST /claim            the same, plus { zh: {code, chars, why}, eg: {code, why}, em: {code, why} } -> saves the codes
//
// Bindings (Worker -> Settings -> Bindings):
//   CODES  a KV namespace that stores the codes
//   AI     Workers AI, which suggests codes from what a song is about
//
// Previews: Spotify's Web API now returns preview_url: null, so this loads the
// public embed page (open.spotify.com/embed/track/ID) and pulls the preview MP3
// link out of its HTML. Song titles come from Spotify's oEmbed API, artists from
// the embed page.
//
// Codes: a song or playlist gets one Chinese code (2-3 common Simplified characters),
// one hieroglyph code (2-3 signs from the Spotiky set of 98) and one emoji code (2-3
// emoji that look the same on Windows, Mac, iPhone and Android). Codes saved for a
// song are its codes for good, so the same song always gets the same codes; a song
// missing a kind of code can still gain one. Skin tones aren't part of a code: 👋🏾🌙,
// 👋🏿🌙 and 👋🌙 are one code, saved without a tone, and the person sharing picks the
// tone for their own link. KV keys:
//   <code>           {type: "track", id} or {type: "playlist", items}, plus meanings
//   track:<id>       {zh, eg, em} for a song
//   list:<hash>      {zh, eg, em} for a playlist
//   shape:<code>     a Chinese code with look-alike characters, so 白光 blocks 自光

const MODEL = "@cf/qwen/qwen3-30b-a3b-fp8";
const WORDS_URL = "https://raw.githubusercontent.com/spotikyhq/spotiky/main/zh-words.json";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const SCRIPTS = ["zh", "eg", "em"];
const CODE_RE = /^[\p{Script=Han}\p{Script=Egyptian_Hieroglyphs}\p{Emoji_Presentation}]{1,6}$/u;
const ID_RE = /^[a-zA-Z0-9]{22}$/;
const ITEM_RE = /^(?:[a-zA-Z0-9]{22}(?:\$\d+(?:-\d+)?)?|[\p{Script=Han}\p{Script=Egyptian_Hieroglyphs}\p{Emoji_Presentation}]{1,6}(?:\d+(?:-\d+)?)?)$/u;
const stripVS = s => String(s || "").replace(/[︎️]/g, "");   // ❤️ and ❤ are one code
const stripTones = s => String(s || "").replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");   // so are 👋🏾 and 👋
const canon = s => stripTones(stripVS(s));

// ---- Character data (generated from the Spotiky glyph review, China's 2013 character
// table and Unicode's emoji list: single emoji from Emoji 11.0 or earlier, no flags) ----
const GLYPHS = /*GLYPHS*/;
const ZH_POOL = new Set(/*ZH_POOL*/);
const ZH_SHAPES = /*ZH_SHAPES*/;
const ZH_BLOCK = new Set(/*ZH_BLOCK*/);
const EMOJI = /*EMOJI*/;
const TONEABLE = new Set(/*TONEABLE*/);   // emoji whose five skin tones show everywhere (Emoji 11.0 or earlier)
const GLYPH_BY_CHAR = new Map(GLYPHS.map(g => [g.c, g]));
const EMOJI_BY_CHAR = new Map(EMOJI.map(x => [x.e, x]));

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/codes") return await codes(url, env);
      if (url.pathname === "/suggest" && request.method === "POST") return await suggest(request, env);
      if (url.pathname === "/claim" && request.method === "POST") return await claim(request, env);
    } catch (err) {
      return json({ error: "Server error", details: String((err && err.message) || err) }, 500);
    }
    return preview(url);
  },
};

// ---- Looking codes up ------------------------------------------------------------

async function codes(url, env) {
  if (!env.CODES) {
    return json({ error: "Codes aren't set up on this Worker yet" }, 503);
  }
  const list = [...new Set((url.searchParams.get("c") || "").split(",").map(c => stripVS(c).trim()).filter(Boolean))];
  if (!list.length || list.length > 50) {
    return json({ error: "Pass 1 to 50 codes, separated by commas, as ?c=" }, 400);
  }
  const out = {};
  await Promise.all(list.map(async asked => {
    out[asked] = null;   // answered under the code as asked, skin tone and all
    const code = stripTones(asked);
    if (!CODE_RE.test(code)) return;
    try {
      out[asked] = await env.CODES.get(code, "json");
    } catch (err) {
      out[asked] = null;   // a value that isn't valid JSON counts as no song
    }
  }));
  return json(out, 200, { "Cache-Control": "public, max-age=60" });
}

// ---- Suggesting codes --------------------------------------------------------------

async function suggest(request, env) {
  if (!env.CODES) return json({ error: "Codes aren't set up on this Worker yet" }, 503);
  const body = await request.json().catch(() => null);
  const target = await parseTarget(body);
  if (!target) return json({ error: "Send a song id or a playlist" }, 400);

  // Codes the song already has stay; only kinds it doesn't have yet get suggestions
  const saved = (await existingCodes(env, target)) || {};
  const missing = SCRIPTS.filter(s => !saved[s]);
  if (!missing.length) return json({ existing: true, ...saved });

  if (!env.AI) return json({ error: "Code suggestions aren't set up on this Worker yet" }, 503);
  const songs = await songsFor(target, env);
  if (!songs.length) return json({ error: "Couldn't read this song from Spotify. Try again in a moment." }, 502);

  const words = await loadWords();
  const prompt = buildPrompt(songs, target.type === "playlist");
  const readers = { zh: ai => readChinese(ai, words), eg: readGlyphs, em: readEmoji };
  const built = Object.fromEntries(missing.map(s => [s, { cands: [], alts: [] }]));
  for (let attempt = 0; attempt < 2 && missing.some(s => !built[s].cands.length); attempt++) {
    const ai = await askAI(env, prompt);
    for (const s of missing) if (!built[s].cands.length) built[s] = readers[s](ai);
  }
  if (missing.every(s => !built[s].cands.length)) {
    if (Object.keys(saved).length) return json({ existing: true, ...saved });
    return json({ error: "Couldn't come up with codes for this one. Try again." }, 502);
  }
  const picks = await Promise.all(missing.map(s => pickFree(env, s, built[s], target, words)));
  const out = { ...saved };
  missing.forEach((s, i) => { if (picks[i]) out[s] = { ...picks[i], saved: false }; });
  return json({ existing: false, ...out, about: songs.map(songLabel) });
}

const SYSTEM = "You name songs with short, poetic codes for Spotiky, a music link app. You write in your own words, never quote song lyrics, and reply with JSON only.";

function buildPrompt(songs, isPlaylist) {
  const subject = isPlaylist
    ? `a playlist of these songs:\n${songs.map((s, i) => `${i + 1}. ${songLabel(s)}`).join("\n")}`
    : `the song ${songLabel(songs[0])}`;
  const what = isPlaylist ? "playlist" : "song";
  const glyphLines = GLYPHS.map(g => `${g.c} ${g.name}: ${g.meaning}`).join("\n");
  return `Make Spotiky codes for ${subject}

A code is two characters that capture what the ${what} is about: its story, mood or imagery, not just the words in its title. Describe themes in your own words and never quote lyrics.

Chinese: give 3 different codes. Each is 2 common Simplified Chinese characters that read naturally to a Chinese speaker, as a real word or a poetic pair. Avoid slang, rude, unlucky or political readings. Give each character a short English meaning. If the pair is an existing Chinese word, put that word's meaning in "word", otherwise null.

Hieroglyphs: give 3 different codes. Each is 2 signs taken only from this list (sign, name: meaning):
${glyphLines}

Emoji: give 3 different codes. Each is 2 emoji, taken only from this list, that tell the ${what}'s story at a glance. Leave people and hands in their default color with no skin tone; the person sharing picks one.
${EMOJI.map(x => x.e).join("")}

For all three kinds, also give 4 alternatives for each position of your first code: characters, signs or emoji that would also fit in that spot.
Write each "why" as one short English line, under 12 words, about the ${what}.

Reply with JSON only, in exactly this shape:
{"zh":[{"code":"..","chars":[{"char":"..","meaning":".."},{"char":"..","meaning":".."}],"word":null,"why":".."}],
"zh_alts":[[{"char":"..","meaning":".."}],[{"char":"..","meaning":".."}]],
"eg":[{"code":"..","why":".."}],
"eg_alts":[["..",".."],["..",".."]],
"em":[{"code":"..","why":".."}],
"em_alts":[["..",".."],["..",".."]]}
/no_think`;
}

async function askAI(env, prompt) {
  try {
    const res = await env.AI.run(MODEL, {
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
      max_tokens: 1400,
      temperature: 0.7,
    });
    const out = res && (res.response ?? res.choices?.[0]?.message?.content ?? res.choices?.[0]?.text);
    if (out && typeof out === "object") return out;
    return parseJsonLoose(String(out || ""));
  } catch (err) {
    return null;
  }
}

function parseJsonLoose(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{"), end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch (err) { return null; }
}

function readChinese(ai, words) {
  const cands = [];
  for (const c of Array.isArray(ai && ai.zh) ? ai.zh : []) {
    const code = typeof (c && c.code) === "string" ? c.code.trim() : "";
    if (zhProblem(code) || cands.some(x => x.code === code)) continue;
    const given = Array.isArray(c.chars) ? c.chars : [];
    cands.push({
      code,
      chars: [...code].map((ch, i) => ({
        char: ch,
        meaning: text((given[i] && given[i].char === ch ? given[i] : given.find(g => g && g.char === ch) || {}).meaning, 30),
      })),
      word: wordFor(code, words) || text(c.word, 40) || null,   // the dictionary wins over the model
      why: text(c.why, 90),
    });
  }
  const alts = [0, 1].map(i => {
    const list = Array.isArray(ai && ai.zh_alts) && Array.isArray(ai.zh_alts[i]) ? ai.zh_alts[i] : [];
    return list
      .filter(a => a && typeof a.char === "string" && [...a.char].length === 1 && ZH_POOL.has(a.char))
      .map(a => ({ char: a.char, meaning: text(a.meaning, 30) }));
  });
  return { cands, alts };
}

function readGlyphs(ai) {
  const cands = [];
  for (const c of Array.isArray(ai && ai.eg) ? ai.eg : []) {
    const code = typeof (c && c.code) === "string" ? c.code.replace(/\s+/g, "") : "";
    if (egProblem(code) || cands.some(x => x.code === code)) continue;
    cands.push({ code, chars: [...code].map(glyphChar), why: text(c.why, 90) });
  }
  const alts = [0, 1].map(i => {
    const list = Array.isArray(ai && ai.eg_alts) && Array.isArray(ai.eg_alts[i]) ? ai.eg_alts[i] : [];
    return list.map(a => (typeof a === "string" ? a : a && a.char)).filter(a => GLYPH_BY_CHAR.has(a)).map(glyphChar);
  });
  return { cands, alts };
}

function glyphChar(ch) {
  const g = GLYPH_BY_CHAR.get(ch);
  return { char: ch, name: g ? g.name : "", meaning: g ? g.meaning : "" };
}

function readEmoji(ai) {
  const cands = [];
  for (const c of Array.isArray(ai && ai.em) ? ai.em : []) {
    const code = typeof (c && c.code) === "string" ? canon(c.code).replace(/\s+/g, "") : "";
    if (emProblem(code) || cands.some(x => x.code === code)) continue;
    cands.push({ code, chars: [...code].map(emojiChar), why: text(c.why, 90) });
  }
  const alts = [0, 1].map(i => {
    const list = Array.isArray(ai && ai.em_alts) && Array.isArray(ai.em_alts[i]) ? ai.em_alts[i] : [];
    return list.map(a => canon(typeof a === "string" ? a : (a && a.char) || "")).filter(a => EMOJI_BY_CHAR.has(a)).map(emojiChar);
  });
  return { cands, alts };
}

// toneable: the page offers skin tones for it
function emojiChar(ch) {
  const x = EMOJI_BY_CHAR.get(ch);
  return { char: ch, name: x ? x.name : "", meaning: x ? x.name : "", toneable: TONEABLE.has(ch) };
}

// The first suggestion nobody else has. If every one is taken, add a third character.
async function pickFree(env, script, built, target, words) {
  if (!built.cands.length) return null;
  for (const c of built.cands) {
    if (await isFree(env, script, c.code, target)) return withOptions(c, built, false);
  }
  const first = built.cands[0];
  for (const extra of built.alts[1] || []) {
    const code = first.code + extra.char;
    if (problem(script, code) || !(await isFree(env, script, code, target))) continue;
    const longer = { ...first, code, chars: [...first.chars, extra] };
    if (script === "zh") longer.word = wordFor(code, words) || null;
    return withOptions(longer, built, false);
  }
  return withOptions(first, built, true);   // all taken: the sharer swaps a character
}

// Dropdown choices for each position: the pick first, then alternatives, then other suggestions' characters
function withOptions(pick, built, taken) {
  const options = pick.chars.map((chosen, i) => {
    const seen = new Set(), list = [];
    for (const o of [chosen, ...(built.alts[i] || []), ...built.cands.map(c => c.chars[i]).filter(Boolean)]) {
      if (!o || seen.has(o.char)) continue;
      seen.add(o.char);
      list.push(o);
    }
    return list.slice(0, 7);
  });
  return { ...pick, options, taken };
}

// ---- Saving codes --------------------------------------------------------------------

async function claim(request, env) {
  if (!env.CODES) return json({ error: "Codes aren't set up on this Worker yet" }, 503);
  const body = await request.json().catch(() => null);
  const target = await parseTarget(body);
  if (!target) return json({ error: "Send a song id or a playlist" }, 400);

  // Kinds of code the song already has stay as they are; only new kinds get saved
  const rec = (await env.CODES.get(target.key, "json")) || {};
  const saved = (await existingCodes(env, target)) || {};
  const codes = {};
  for (const s of SCRIPTS) {
    const raw = body[s] && typeof body[s].code === "string" ? canon(body[s].code).replace(/\s+/g, "") : "";
    if (raw && !rec[s]) codes[s] = raw;
  }
  if (!Object.keys(codes).length) {
    if (Object.keys(saved).length) return json({ existing: true, ...saved });
    return json({ error: "Send a Chinese, hieroglyph or emoji code" }, 400);
  }
  for (const [script, code] of Object.entries(codes)) {
    const why = problem(script, code);
    if (why) return json({ error: why, script, code }, 400);
    if (!(await isFree(env, script, code, target))) {
      return json({ error: `${code} already belongs to another ${script === "zh" ? "song or a look-alike code" : "song"}`, script, code, taken: true }, 409);
    }
  }

  const at = new Date().toISOString();
  const base = target.type === "track" ? { type: "track", id: target.id } : { type: "playlist", items: target.items };
  const writes = [];
  const out = {};
  if (codes.zh) {
    const zh = codes.zh;
    const words = await loadWords();
    const given = Array.isArray(body.zh.chars) ? body.zh.chars : [];
    const chars = [...zh].map((ch, i) => ({ char: ch, meaning: text(given[i] && given[i].char === ch ? given[i].meaning : "", 30) }));
    out.zh = { code: zh, chars, word: wordFor(zh, words) || text(body.zh.word, 40) || null, why: text(body.zh.why, 90), saved: true };
    writes.push(env.CODES.put(zh, JSON.stringify({ ...base, script: "zh", chars, word: out.zh.word, why: out.zh.why, at })));
    if (hasShapeChar(zh)) writes.push(env.CODES.put(shapeKey(zh), zh));
  }
  if (codes.eg) {
    out.eg = { code: codes.eg, chars: [...codes.eg].map(glyphChar), why: text(body.eg.why, 90), saved: true };
    writes.push(env.CODES.put(codes.eg, JSON.stringify({ ...base, script: "eg", why: out.eg.why, at })));
  }
  if (codes.em) {
    out.em = { code: codes.em, chars: [...codes.em].map(emojiChar), why: text(body.em.why, 90), saved: true };
    writes.push(env.CODES.put(codes.em, JSON.stringify({ ...base, script: "em", why: out.em.why, at })));
  }
  const merged = { at: rec.at || at };
  for (const s of SCRIPTS) merged[s] = rec[s] || codes[s] || null;
  writes.push(env.CODES.put(target.key, JSON.stringify(merged)));
  await Promise.all(writes);
  return json({ existing: Object.keys(saved).length > 0, ...saved, ...out });
}

// The codes a song or playlist already has: { zh?, eg?, em? }, each marked saved
async function existingCodes(env, target) {
  const rec = await env.CODES.get(target.key, "json");
  if (!rec || !SCRIPTS.some(s => rec[s])) return null;
  const recs = await Promise.all(SCRIPTS.map(s => (rec[s] ? env.CODES.get(rec[s], "json") : null)));
  const out = {};
  SCRIPTS.forEach((s, i) => {
    const code = rec[s];
    if (!code) return;
    const r = recs[i] || {};
    if (s === "zh") {
      out.zh = { code, chars: Array.isArray(r.chars) ? r.chars : [...code].map(ch => ({ char: ch, meaning: "" })), word: r.word || null, why: r.why || "", saved: true };
    } else {
      out[s] = { code, chars: [...code].map(s === "eg" ? glyphChar : emojiChar), why: r.why || "", saved: true };
    }
  });
  return out;
}

// ---- Rules for codes -------------------------------------------------------------------

function problem(script, code) {
  return script === "zh" ? zhProblem(code) : script === "eg" ? egProblem(code) : emProblem(code);
}

function emProblem(code) {
  const cs = [...String(code || "")];
  if (cs.length < 2 || cs.length > 3) return "An emoji code needs 2 or 3 emoji";
  if (!cs.every(c => EMOJI_BY_CHAR.has(c))) return "Emoji codes use emoji from the Spotiky set only";
  return null;
}

function zhProblem(code) {
  const cs = [...String(code || "")];
  if (cs.length < 2 || cs.length > 3) return "A Chinese code needs 2 or 3 characters";
  if (!cs.every(c => ZH_POOL.has(c))) return "Chinese codes use common Simplified characters only";
  for (let i = 0; i + 1 < cs.length; i++) {
    if (ZH_BLOCK.has(cs[i] + cs[i + 1])) return "That code reads as a word Spotiky doesn't use";
  }
  return null;
}

function egProblem(code) {
  const cs = [...String(code || "")];
  if (cs.length < 2 || cs.length > 3) return "A hieroglyph code needs 2 or 3 signs";
  if (!cs.every(c => GLYPH_BY_CHAR.has(c))) return "Hieroglyph codes use signs from the Spotiky set only";
  return null;
}

const hasShapeChar = code => [...code].some(c => ZH_SHAPES[c]);
const shapeKey = code => "shape:" + [...code].map(c => ZH_SHAPES[c] || c).join("");

async function isFree(env, script, code, target) {
  const rec = await env.CODES.get(code, "json");
  if (rec && !sameTarget(rec, target)) return false;
  if (script === "zh" && hasShapeChar(code)) {
    const owner = await env.CODES.get(shapeKey(code));
    if (owner && owner !== code) return false;   // a look-alike of a code that exists
  }
  return true;
}

function sameTarget(rec, target) {
  return rec.type === target.type && (target.type === "track" ? rec.id === target.id : rec.items === target.items);
}

async function parseTarget(body) {
  if (!body || typeof body !== "object") return null;
  if (body.type === "track" && ID_RE.test(body.id || "")) {
    return { type: "track", id: body.id, key: "track:" + body.id };
  }
  if (body.type === "playlist" && typeof body.items === "string") {
    const items = canon(body.items).trim();   // the same songs with other skin tones are the same playlist
    const tokens = items.split(",");
    if (!items || items.length > 4000 || tokens.length > 100 || !tokens.every(t => ITEM_RE.test(t))) return null;
    return { type: "playlist", items, key: "list:" + (await sha256(items)) };
  }
  return null;
}

// ---- Song details ------------------------------------------------------------------------

async function songsFor(target, env) {
  if (target.type === "track") {
    const s = await songInfo(target.id);
    return s ? [s] : [];
  }
  const ids = [];
  for (const token of target.items.split(",")) {
    if (ids.length >= 8) break;
    const id = token.slice(0, 22);
    if (ID_RE.test(id)) { ids.push(id); continue; }
    const code = canon(token.replace(/[\d-]+$/, ""));
    const rec = await env.CODES.get(code, "json").catch(() => null);
    if (rec && rec.type === "track" && ID_RE.test(rec.id)) ids.push(rec.id);
  }
  return (await Promise.all(ids.map(songInfo))).filter(Boolean);
}

// A song's title and artists. The title comes from Spotify's oEmbed API (the embed page
// stopped carrying a <title>); the artists come from the embed page.
async function songInfo(id) {
  const [oembed, html] = await Promise.all([oembedTitle(id), embedPage(id)]);
  const title = oembed || (html && titleIn(html));
  return title ? { title, artist: (html && artistsIn(html)) || null } : null;
}

async function oembedTitle(id) {
  try {
    const page = encodeURIComponent(`https://open.spotify.com/track/${id}`);
    const res = await fetch(`https://open.spotify.com/oembed?url=${page}`, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.title === "string" && data.title.trim() ? data.title.trim() : null;
  } catch (err) {
    return null;
  }
}

// The public embed page: it carries the preview MP3 and the artists
async function embedPage(id) {
  try {
    const res = await fetch(`https://open.spotify.com/embed/track/${id}`, { headers: { "User-Agent": UA } });
    return res.ok ? await res.text() : null;
  } catch (err) {
    return null;
  }
}

// The title on an embed page, for when oEmbed doesn't answer
function titleIn(html) {
  for (const m of [
    html.match(/<title[^>]*>([^<]+)<\/title>/),
    html.match(/<h1\b[^>]*>(?:\s*<[^>]+>)*\s*([^<]+)</),
    html.match(/<img\b[^>]*\balt="([^"]+?) cover"/),
  ]) {
    if (!m) continue;
    const t = entities(m[1]).replace(/\s*\|\s*Spotify\s*$/i, "").replace(/\s+-\s+song(?: and lyrics)? by\s+.+$/i, "").trim();
    if (t && !/^spotify(?: embed)?$/i.test(t)) return t;
  }
  return null;
}

// Up to three artist names from an embed page: its data's "artists" list, else its artist links
function artistsIn(html) {
  const names = [];
  const add = n => { n = (n || "").trim(); if (n && !names.includes(n) && names.length < 3) names.push(n); };
  const list = html.match(/"artists":\s*\[([^\]]*)\]/);
  if (list) for (const m of list[1].matchAll(/"name":\s*"((?:[^"\\]|\\.)*)"/g)) add(unjson(m[1]));
  if (!names.length) {
    for (const m of html.matchAll(/<a\b[^>]*\bhref="[^"]*\/artist\/[A-Za-z0-9]{22}[^"]*"[^>]*>(?:\s*<[^>]+>)*\s*([^<]+)</g)) add(entities(m[1]));
  }
  if (!names.length) {
    const t = html.match(/<title[^>]*>[^<]*?\s-\s+song(?: and lyrics)? by\s+([^<|]+)/i);
    if (t) add(entities(t[1]));
  }
  return names.length ? names.join(", ") : null;
}

const songLabel = s => `"${s.title}"` + (s.artist ? ` by ${s.artist}` : "");

const unjson = s => { try { return JSON.parse(`"${s}"`); } catch (err) { return s; } };

function entities(s) {
  const cp = n => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => cp(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

// Common two-character words, so a code that is also a real word says what that word means
let wordsPromise = null;
function loadWords() {
  if (!wordsPromise) {
    wordsPromise = fetch(WORDS_URL, { cf: { cacheTtl: 86400, cacheEverything: true } })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error("words " + r.status))))
      .catch(() => { wordsPromise = null; return {}; });
  }
  return wordsPromise;
}

function wordFor(code, words) {
  return (words && typeof words[code] === "string" && words[code]) || null;
}

// ---- Previews (unchanged) ----------------------------------------------------------------

async function preview(url) {
  const trackId = url.searchParams.get("id");

  if (!trackId || !/^[a-zA-Z0-9]{22}$/.test(trackId)) {
    return json({ error: "Missing or invalid track id" }, 400);
  }

  try {
    const [title, html] = await Promise.all([oembedTitle(trackId), embedPage(trackId)]);
    if (html == null && !title) {
      return json({ error: "Could not load embed page" }, 502);
    }

    let previewUrl = null;
    if (html) {
      const match1 = html.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[a-zA-Z0-9]+/);
      if (match1) previewUrl = match1[0];

      if (!previewUrl) {
        const nextDataMatch = html.match(/"audioPreview":\s*{\s*"url":\s*"([^"]+)"/);
        if (nextDataMatch) previewUrl = nextDataMatch[1];
      }
    }

    return json({
      preview_url: previewUrl,
      name: title || (html && titleIn(html)) || null,
      source: previewUrl ? "embed" : null,
    });
  } catch (err) {
    return json({ error: "Server error", details: err.message }, 500);
  }
}

// ---- Helpers -------------------------------------------------------------------------------

function text(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders,
    },
  });
}
