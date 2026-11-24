// Spotiky Worker. Runs on Cloudflare Workers, not GitHub Pages.
// Live at https://spotiky-preview.spotikyhq.workers.dev, and in front of GitHub Pages on
// spotiky.com, where it gives every song, code and playlist link its own preview card in
// Discord, iMessage, WhatsApp, Slack and X (see "spotiky.com: pages with link previews").
//
// Songs
//   GET  /?id=TRACK_ID        a track's preview MP3 and song name: { preview_url, name, source }
//   GET  /codes?c=夜光,𓇰𓇶      which song each code stands for: { "夜光": {type: "track", id}, "𓇰𓇶": null }
//   POST /suggest             { type: "track", id } -> code suggestions for the song
//   POST /claim               the same, plus { zh: {code, chars, why}, eg: {code, why}, em: {code, why} } -> saves them
// Playlists
//   GET  /playlist?id=5mh     a saved playlist: { id, items, labels, mine }
//   POST /playlist/suggest    { items } -> an ID and a set of four labels for the playlist
//   POST /playlist/save       { items, labels } saves it (signed in, it's yours); { edit: id, items } changes yours
//   GET  /playlists/mine      the signed-in person's playlists
// Accounts: email + a 6-digit code. Signed-in requests carry "Authorization: Bearer <token>".
//   POST /auth/start          { email } -> emails a sign-in code
//   POST /auth/verify         { email, code } -> { token }
//   GET  /auth/me             who's signed in
//   POST /auth/signout        ends this sign-in
//
// Settings (Worker -> Settings):
//   DB              binding to a D1 database; the Worker creates its own tables
//   AI              binding to Workers AI, which suggests codes from what a song is about
//   RESEND_API_KEY  secret: sends the sign-in codes (resend.com)
//   PEPPER          secret: long random text mixed into every stored hash. Never change it.
// Only hashes of emails, sign-in codes and sign-ins are stored, never the emails themselves.
//
// Songs: Spotify's Web API returns preview_url: null now, so previews come from the public
// embed page (open.spotify.com/embed/track/ID). Titles come from Spotify's oEmbed API,
// artists from the embed page.
//
// Song codes: a song gets one Chinese code (2-3 common Simplified characters), one
// hieroglyph code (2-3 signs from the Spotiky set of 98) and one emoji code (2-3 emoji that
// look the same on Windows, Mac, iPhone and Android). A code belongs to one song for good,
// first come, first served. The database itself refuses a second owner, so two people
// claiming the same code at the same moment can't both get it. Skin tones aren't part of a
// code: 👋🏾🌙 and 👋🌙 are one code, and the person sharing picks the tone for their link.
//
// Playlist links: spotiky.com/playlist/<id><label>, like 5mh夜歌 or 5mh-night-drive. The ID
// (3 or more characters from 32 that can't be mixed up, always with a digit) finds the
// playlist. The label is one of a matching set in Chinese, hieroglyphs, emoji and English;
// labels can repeat. Saved without signing in, a playlist is a snapshot whose ID comes from a
// fingerprint of its songs and times. A signed-in person's playlist gets its own ID and stays
// theirs to edit.

// Workers AI models, in order. Cloudflare retires models now and then (the Qwen3 30B this used
// went on 2026-11-20), so when one fails the next is asked. These are the smaller models
// Cloudflare suggested as replacements. Gemma 4 runs on the free plan.
const MODELS = ["@cf/google/gemma-4-26b-a4b-it", "@cf/qwen/qwen3.8-27b"];
// Both can think before answering. Here that only costs time: with thinking on, a playlist took
// over 20 seconds and the thinking used up every token, leaving an empty reply.
const NO_THINKING = { enable_thinking: false };
// How long one model gets before the next is asked, so a model that's queued doesn't hang the page
const AI_TIMEOUT_MS = 30000;
const WORDS_URL = "https://raw.githubusercontent.com/spotikyhq/spotiky/main/zh-words.json";
const FROM = "Spotiky <code@spotiky.com>";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const SCRIPTS = ["zh", "eg", "em"];            // kinds of song code
const LABELS = ["zh", "eg", "em", "en"];       // kinds of playlist label
const CODE_RE = /^[\p{Script=Han}\p{Script=Egyptian_Hieroglyphs}\p{Emoji_Presentation}]{1,6}$/u;
const ID_RE = /^[a-zA-Z0-9]{22}$/;
const ITEM_RE = /^(?:[a-zA-Z0-9]{22}(?:\$\d+(?:-\d+)?)?|[\p{Script=Han}\p{Script=Egyptian_Hieroglyphs}\p{Emoji_Presentation}]{1,6}(?:\d+(?:-\d+)?)?)$/u;
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";   // no i, l, o or u: nothing to mix up with 1 or 0
// Every playlist ID has a digit (5mh, k7f), so a word is never read as an ID
const PLAYLIST_ID_RE = /^(?=.*[0-9])[0-9a-hjkmnp-tv-z]{3,13}$/;
// Words no ID may contain, also when spelled with numbers: a55, 5h1t, b00b, 8008, c0ck.
// Letters IDs can't have (i, l, o, u) only ever show up as their number stand-ins.
const ID_BLOCK = ["ass", "sex", "fag", "fgt", "fuck", "phuck", "fck", "fk", "kkk", "xxx", "wtf", "fap", "shit", "sht",
  "dick", "dck", "dik", "cock", "cunt", "cum", "piss", "tit", "boob", "penis", "porn", "slut", "whore", "hoe",
  "bitch", "btch", "twat", "wank", "jizz", "vag", "rape", "pedo", "kys", "nig", "negro", "nazi", "hitler", "1488",
  "kike", "spic", "chink", "gook", "coon", "jap", "wop", "dyke", "homo", "tranny", "retard"];
const LEET = { a: "4", b: "8", c: "k", e: "3", g: "69", i: "1", l: "1", o: "0", s: "5", t: "7", u: "v", z: "2" };
const ID_BLOCK_RE = new RegExp(ID_BLOCK.map(w => [...w].map(ch => LEET[ch] ? `[${ch}${LEET[ch]}]` : ch).join("")).join("|"));
const EN_RE = /^[a-z]{2,12}(?:-[a-z]{2,12})?$/;
const MINUTE = 60e3, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const CODE_MINUTES = 10, CODE_TRIES = 5, SESSION_DAYS = 30;
const RENAMES_PER_DAY = 3;     // per playlist, over the last 24 hours
const MAX_PINNED = 4;          // playlists on an owner's featured shelf
const NOTE_MAX = 140;          // characters in a liner note
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
// English words a label can't use: the LDNOOBW list (github.com/LDNOOBW, CC BY 4.0)
const EN_BLOCK = new Set(/*EN_BLOCK*/);
const GLYPH_BY_CHAR = new Map(GLYPHS.map(g => [g.c, g]));
const EMOJI_BY_CHAR = new Map(EMOJI.map(x => [x.e, x]));

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ROUTES = {
  "GET /codes": codes,
  "POST /suggest": suggest,
  "POST /claim": claim,
  "GET /playlist": getPlaylist,
  "POST /playlist/suggest": suggestPlaylist,
  "POST /playlist/save": savePlaylist,
  "GET /playlists/mine": myPlaylists,
  "GET /playlist/history": playlistHistory,
  "POST /playlist/rename": renamePlaylist,
  "POST /playlist/shelf": shelvePlaylist,
  "POST /playlist/delete": deletePlaylist,
  "POST /playlist/restore": restorePlaylist,
  "POST /labels": labelsFor,
  "GET /codes/mine": myCodes,
  "GET /sets": sets,
  "POST /auth/start": startSignIn,
  "POST /auth/verify": verifySignIn,
  "GET /auth/me": me,
  "POST /auth/signout": signOut,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (SITE_HOSTS.has(url.hostname)) return site(request, env, ctx, url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const handler = ROUTES[`${request.method} ${url.pathname}`];
    if (!handler) return preview(url);
    const body = request.method === "POST" ? await request.json().catch(() => null) : null;
    const req = { url, body, request, env };
    try {
      return await handler(req);
    } catch (err) {
      if (err instanceof OutOfAI) return outOfAI();
      // A new database has no tables yet: make them, then try once more
      if (env.DB && /no such table/i.test(String(err && err.message))) {
        try {
          await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
          return await handler(req);
        } catch (err2) {
          return err2 instanceof OutOfAI ? outOfAI() : serverError(err2);
        }
      }
      return serverError(err);
    }
  },
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS song_codes (code TEXT PRIMARY KEY, script TEXT NOT NULL, track TEXT NOT NULL,
     chars TEXT, word TEXT, why TEXT, created TEXT NOT NULL, UNIQUE (track, script))`,
  `CREATE TABLE IF NOT EXISTS zh_shapes (shape TEXT PRIMARY KEY, code TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, items TEXT NOT NULL, hash TEXT NOT NULL, owner TEXT,
     labels TEXT NOT NULL, why TEXT, created TEXT NOT NULL, updated TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS playlist_snapshots ON playlists (hash) WHERE owner IS NULL`,
  `CREATE INDEX IF NOT EXISTS playlists_by_owner ON playlists (owner, updated)`,
  `CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sign_in_codes (email TEXT PRIMARY KEY, code TEXT NOT NULL, expires INTEGER NOT NULL,
     tries INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, owner TEXT NOT NULL, expires INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sends (key TEXT NOT NULL, at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sends_by_key ON sends (key, at)`,
  // A playlist's trail: when it was made, renamed and edited
  `CREATE TABLE IF NOT EXISTS playlist_history (list TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
     detail TEXT NOT NULL DEFAULT '')`,
  `CREATE INDEX IF NOT EXISTS history_by_list ON playlist_history (list, at)`,
  // How an owner keeps their playlists: pinned to the featured shelf, in a crate, or deleted
  `CREATE TABLE IF NOT EXISTS shelf (id TEXT PRIMARY KEY, owner TEXT NOT NULL, pinned TEXT, crate TEXT, deleted TEXT)`,
  `CREATE INDEX IF NOT EXISTS shelf_by_owner ON shelf (owner)`,
  // A line of text per song of an owned playlist, shown while it plays
  `CREATE TABLE IF NOT EXISTS liner_notes (list TEXT PRIMARY KEY, notes TEXT NOT NULL)`,
  // Song codes saved while signed in: shown in that person's collection, still everyone's to use
  `CREATE TABLE IF NOT EXISTS namers (code TEXT PRIMARY KEY, owner TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS namers_by_owner ON namers (owner, at)`,
];

const notSetUp = () => json({ error: "Codes aren't set up on this Worker yet. It needs its DB binding." }, 503);
const serverError = err => json({ error: "Server error", details: String((err && err.message) || err) }, 500);

// ---- Song codes: looking up -----------------------------------------------------------

async function codes({ url, env }) {
  if (!env.DB) return notSetUp();
  const list = [...new Set((url.searchParams.get("c") || "").split(",").map(c => stripVS(c).trim()).filter(Boolean))];
  if (!list.length || list.length > 50) {
    return json({ error: "Pass 1 to 50 codes, separated by commas, as ?c=" }, 400);
  }
  const keys = [...new Set(list.map(stripTones).filter(c => CODE_RE.test(c)))];
  const rows = keys.length
    ? (await env.DB.prepare(`SELECT code, track FROM song_codes WHERE code IN (${keys.map(() => "?").join(",")})`).bind(...keys).all()).results
    : [];
  const found = new Map(rows.map(r => [r.code, r.track]));
  const out = {};
  for (const asked of list) {   // answered under the code as asked, skin tone and all
    const track = found.get(stripTones(asked));
    out[asked] = track ? { type: "track", id: track } : null;
  }
  // A saved code never changes, so answers can be cached; "no song yet" can change any minute
  const allFound = list.every(c => out[c]);
  return json(out, 200, { "Cache-Control": allFound ? "public, max-age=300" : "no-store" });
}

// The codes a song already has: { zh?, eg?, em? }, each marked saved
async function songCodes(db, track) {
  const rows = (await db.prepare("SELECT code, script, chars, word, why FROM song_codes WHERE track = ?").bind(track).all()).results;
  const out = {};
  for (const r of rows) {
    out[r.script] = r.script === "zh"
      ? { code: r.code, chars: parseChars(r.chars, r.code), word: r.word || null, why: r.why || "", saved: true }
      : { code: r.code, chars: [...r.code].map(r.script === "eg" ? glyphChar : emojiChar), why: r.why || "", saved: true };
  }
  return out;
}

function parseChars(value, code) {
  try {
    const list = JSON.parse(value || "[]");
    if (Array.isArray(list) && list.length === [...code].length) return list;
  } catch (err) {}
  return [...code].map(ch => ({ char: ch, meaning: "" }));
}

// ---- Song codes: suggesting -----------------------------------------------------------

async function suggest({ body, env }) {
  if (!env.DB) return notSetUp();
  const track = body && body.type === "track" && ID_RE.test(body.id || "") ? body.id : null;
  if (!track) return json({ error: "Send a song id" }, 400);

  // Codes the song already has stay; only kinds it doesn't have yet get suggestions
  const saved = await songCodes(env.DB, track);
  const missing = SCRIPTS.filter(s => !saved[s]);
  if (!missing.length) return json({ existing: true, ...saved });

  if (!env.AI) return json({ error: "Code suggestions aren't set up on this Worker yet" }, 503);
  const songs = await songsFor(track, env.DB);
  if (!songs.length) return json({ error: "Couldn't read this song from Spotify. Try again in a moment." }, 502);

  const words = await loadWords();
  const built = await askForCodes(env, songs, false, missing, words);
  if (missing.every(s => !built[s].cands.length)) {
    if (Object.keys(saved).length) return json({ existing: true, ...saved });
    return json({ error: "Couldn't come up with codes for this one. Try again." }, 502);
  }
  const picks = await Promise.all(missing.map(s => pickFree(env.DB, s, built[s], track, words)));
  const out = { ...saved };
  missing.forEach((s, i) => { if (picks[i]) out[s] = { ...picks[i], saved: false }; });
  return json({ existing: false, ...out, about: songs.map(songLabel) });
}

// The first suggestion nobody else has. If every one is taken, add a third character.
async function pickFree(db, script, built, track, words) {
  if (!built.cands.length) return null;
  for (const c of built.cands) {
    if (await isFree(db, script, c.code, track)) return withOptions(c, built, false);
  }
  const first = built.cands[0];
  for (const extra of built.alts[1] || []) {
    const code = first.code + extra.char;
    if (problem(script, code) || !(await isFree(db, script, code, track))) continue;
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

async function isFree(db, script, code, track) {
  const row = await db.prepare("SELECT track FROM song_codes WHERE code = ?").bind(code).first();
  if (row && row.track !== track) return false;
  if (script === "zh" && hasShapeChar(code)) {
    const shape = await db.prepare("SELECT code FROM zh_shapes WHERE shape = ?").bind(shapeOf(code)).first();
    if (shape && shape.code !== code) return false;   // a look-alike of a code that exists
  }
  return true;
}

// ---- Song codes: saving ------------------------------------------------------------------

async function claim({ body, env, request }) {
  if (!env.DB) return notSetUp();
  const db = env.DB;
  const track = body && body.type === "track" && ID_RE.test(body.id || "") ? body.id : null;
  if (!track) return json({ error: "Send a song id" }, 400);
  if (!(await allow(db, "claim:" + (await ipKey(request, env)), 30, HOUR))) {
    return json({ error: "Too many codes saved from here. Try again in a while." }, 429);
  }

  let saved = await songCodes(db, track);
  let codes = wantedCodes(body, saved);
  if (!Object.keys(codes).length) {
    if (Object.keys(saved).length) return json({ existing: true, ...saved });
    return json({ error: "Send a Chinese, hieroglyph or emoji code" }, 400);
  }
  for (const [script, code] of Object.entries(codes)) {
    const why = problem(script, code);
    if (why) return json({ error: why, script, code }, 400);
    if (!(await isFree(db, script, code, track))) return takenReply(script, code);
  }
  // Only real songs get codes, so nobody can sit on codes with made-up song IDs
  if (!(await oembedTitle(track)) && !(await embedPage(track))) {
    return json({ error: "Couldn't find this song on Spotify." }, 404);
  }

  const words = await loadWords();
  const namer = await signedIn(request, env);   // codes saved while signed in show in that person's collection
  for (let attempt = 0; attempt < 2; attempt++) {
    const at = new Date().toISOString();
    const out = {}, writes = [];
    for (const [script, code] of Object.entries(codes)) {
      const given = body[script] || {};
      const why = text(given.why, 90);
      if (script === "zh") {
        const g = Array.isArray(given.chars) ? given.chars : [];
        const chars = [...code].map((ch, i) => ({ char: ch, meaning: text(g[i] && g[i].char === ch ? g[i].meaning : "", 30) }));
        const word = wordFor(code, words) || text(given.word, 40) || null;
        out.zh = { code, chars, word, why, saved: true };
        writes.push(db.prepare("INSERT INTO song_codes (code, script, track, chars, word, why, created) VALUES (?, 'zh', ?, ?, ?, ?, ?)")
          .bind(code, track, JSON.stringify(chars), word, why, at));
        if (hasShapeChar(code)) writes.push(db.prepare("INSERT INTO zh_shapes (shape, code) VALUES (?, ?)").bind(shapeOf(code), code));
      } else {
        out[script] = { code, chars: [...code].map(script === "eg" ? glyphChar : emojiChar), why, saved: true };
        writes.push(db.prepare("INSERT INTO song_codes (code, script, track, chars, word, why, created) VALUES (?, ?, ?, NULL, NULL, ?, ?)")
          .bind(code, script, track, why, at));
      }
    }
    if (namer) for (const code of Object.values(codes)) writes.push(db.prepare("INSERT INTO namers (code, owner, at) VALUES (?, ?, ?)").bind(code, namer, at));
    try {
      // One transaction: every code is saved, or none is
      await db.batch(writes);
      return json({ existing: Object.keys(saved).length > 0, ...saved, ...out });
    } catch (err) {
      if (!isConflict(err)) throw err;
    }
    // Someone else saved first: a code went to another song, or this song gained codes
    saved = await songCodes(db, track);
    for (const [script, code] of Object.entries(codes)) {
      if (!saved[script] && !(await isFree(db, script, code, track))) return takenReply(script, code, true);
    }
    codes = wantedCodes(body, saved);
    if (!Object.keys(codes).length) break;
  }
  return json({ existing: true, ...saved });
}

function wantedCodes(body, saved) {
  const codes = {};
  for (const s of SCRIPTS) {
    const raw = body[s] && typeof body[s].code === "string" ? canon(body[s].code).replace(/\s+/g, "") : "";
    if (raw && !saved[s]) codes[s] = raw;   // kinds the song already has stay as they are
  }
  return codes;
}

function takenReply(script, code, justNow) {
  const whose = script === "zh" ? "song or a look-alike code" : "song";
  return json({ error: `${code} ${justNow ? "just went" : "already belongs"} to another ${whose}`, script, code, taken: true }, 409);
}

// ---- Asking the AI ---------------------------------------------------------------------------

const SYSTEM = "You name songs with short, poetic codes for Spotiky, a music link app. You write in your own words, never quote song lyrics, and reply with JSON only.";

// Suggestions for the given kinds: { zh: {cands, alts}, ... }. If an answer leaves a kind with
// nothing usable, the next model is asked for it.
async function askForCodes(env, songs, isPlaylist, kinds, words) {
  const readers = { zh: ai => readChinese(ai, words), eg: readGlyphs, em: readEmoji, en: readEnglish };
  const built = Object.fromEntries(kinds.map(s => [s, { cands: [], alts: [] }]));
  await askAI(env, buildPrompt(songs, isPlaylist), isPlaylist ? 1700 : 1400,
    ai => fillFrom(built, kinds, readers, ai), () => kinds.some(s => !built[s].cands.length));
  return built;
}

// Keeps the first usable suggestions for each kind; alternatives alone count until then
function fillFrom(built, kinds, readers, ai) {
  for (const s of kinds) {
    if (built[s].cands.length) continue;
    const r = readers[s](ai);
    if (r.cands.length || !built[s].alts.length) built[s] = r;
  }
}

function buildPrompt(songs, isPlaylist) {
  const subject = isPlaylist
    ? `a playlist of these songs:\n${songs.map((s, i) => `${i + 1}. ${songLabel(s)}`).join("\n")}`
    : `the song ${songLabel(songs[0])}`;
  const what = isPlaylist ? "playlist" : "song";
  const glyphLines = GLYPHS.map(g => `${g.c} ${g.name}: ${g.meaning}`).join("\n");
  const english = isPlaylist
    ? `\nEnglish: give 3 different labels. Each is one or two common English words in lowercase, joined by a hyphen when there are two (like "night-drive"), that capture the playlist.\n`
    : "";
  return `Make Spotiky codes for ${subject}

A code is two characters that capture what the ${what} is about: its story, mood or imagery, not just the words in its title. Describe themes in your own words and never quote lyrics.

Chinese: give 3 different codes. Each is 2 common Simplified Chinese characters that read naturally to a Chinese speaker, as a real word or a poetic pair. Avoid slang, rude, unlucky or political readings. Give each character a short English meaning. If the pair is an existing Chinese word, put that word's meaning in "word", otherwise null.

Hieroglyphs: give 3 different codes. Each is 2 signs taken only from this list (sign, name: meaning):
${glyphLines}

Emoji: give 3 different codes. Each is 2 emoji, taken only from this list, that tell the ${what}'s story at a glance. Leave people and hands in their default color with no skin tone; the person sharing picks one.
${EMOJI.map(x => x.e).join("")}
${english}
For every kind, also give 4 alternatives for each position of your first code: characters, signs, emoji${isPlaylist ? " or words" : ""} that would also fit in that spot.
Write each "why" as one short English line, under 12 words, about the ${what}.

Reply with JSON only, in exactly this shape:
{"zh":[{"code":"..","chars":[{"char":"..","meaning":".."},{"char":"..","meaning":".."}],"word":null,"why":".."}],
"zh_alts":[[{"char":"..","meaning":".."}],[{"char":"..","meaning":".."}]],
"eg":[{"code":"..","why":".."}],
"eg_alts":[["..",".."],["..",".."]],
"em":[{"code":"..","why":".."}],
"em_alts":[["..",".."],["..",".."]]${isPlaylist ? `,
"en":[{"code":"..","why":".."}],
"en_alts":[["..",".."],["..",".."]]` : ""}}`;
}

// Workers AI's free plan allows 10,000 neurons a day, reset at 00:00 UTC. Past that, every call
// fails with error 3036 until the reset, so trying again doesn't help.
class OutOfAI extends Error {}
const AI_LIMIT_RE = /\b3036\b|daily free allocation/i;

// Errors that mean a model can't be used at all: retired (5028), unknown (5007) or paid plan only (5035)
const MODEL_GONE_RE = /\b(5028|5007|5035)\b|deprecated|no such model/i;
// Errors that mean the request itself was refused, as when a model doesn't take the thinking switch
const BAD_INPUT_RE = /\b5006\b|chat_template_kwargs|validation|oneOf|additional propert/i;
// Per Worker instance, so a model that's gone or won't take the switch isn't asked that way every time
const goneModels = new Set(), noSwitch = new Set();

// Asks each model in turn. With `take`, every usable answer goes to it, and the next model is
// asked only while `wanted()` says something is still missing; without, the first usable answer
// is returned. Any failure moves on to the next model. Only running out of the daily
// allowance stops it, since every model shares that.
async function askAI(env, prompt, maxTokens, take, wanted) {
  const limit = Number(env.AI_TIMEOUT_MS) || AI_TIMEOUT_MS;
  for (const model of MODELS) {
    if (goneModels.has(model) && model !== MODELS[MODELS.length - 1]) continue;
    const started = Date.now();
    let res;
    try {
      res = await runModel(env, model, prompt, maxTokens, limit);
    } catch (err) {
      const why = String((err && err.message) || err);
      console.log(`Workers AI failed (${model}): ` + why.slice(0, 300));   // shows in `wrangler tail`
      if (AI_LIMIT_RE.test(why)) throw new OutOfAI(why);
      if (MODEL_GONE_RE.test(why)) goneModels.add(model);
      continue;
    }
    const out = replyOf(res);
    const answer = typeof out === "object" ? out : parseJsonLoose(out);
    if (!answer) {
      // The end of the reply shows whether it was cut off or just wasn't JSON; the finish reason
      // and token counts show whether thinking used up the budget
      const c = res && res.choices && res.choices[0];
      const why = [c && c.finish_reason && `finish ${c.finish_reason}`, res && res.usage && `tokens ${JSON.stringify(res.usage)}`].filter(Boolean).join(", ");
      console.log(`Workers AI reply wasn't JSON (${model}, ${out.length} chars${why ? ", " + why : ""}), ending: ` + out.slice(-200));
      continue;
    }
    console.log(`Workers AI answered (${model}) in ${Date.now() - started} ms`);
    if (!take) return answer;
    take(answer);
    if (!wanted || !wanted()) return answer;
  }
  return null;
}

async function runModel(env, model, prompt, maxTokens, limit) {
  const input = {
    messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.7,
  };
  if (!noSwitch.has(model)) input.chat_template_kwargs = NO_THINKING;
  try {
    return await withTimeout(env.AI.run(model, input), limit);
  } catch (err) {
    const why = String((err && err.message) || err);
    if (!input.chat_template_kwargs || !BAD_INPUT_RE.test(why)) throw err;
    console.log(`Workers AI refused the thinking switch (${model}), asking without it: ` + why.slice(0, 200));
    noSwitch.add(model);
    const { chat_template_kwargs, ...plain } = input;
    return await withTimeout(env.AI.run(model, plain), limit);
  }
}

// The reply's text, or its object when the model gave JSON directly. Newer models answer in the
// chat completions shape, older ones in `response`.
function replyOf(res) {
  const c = res && res.choices && res.choices[0];
  for (const v of [res && res.response, c && c.message && c.message.content, c && c.text]) {
    if (v && typeof v === "object") return v;
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms); }),
  ]);
}

function outOfAI() {
  const now = new Date();
  const secs = Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now) / 1000);
  const hours = Math.ceil(secs / 3600);
  const when = hours <= 1 ? "in under an hour" : `in about ${hours} hours`;
  // 429, not 503: the page reads 503 as the Worker not being set up
  return json({ error: `Spotiky has used up today's code suggestions. They come back ${when}.` }, 429, { "Retry-After": String(secs) });
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

// English labels are words; each word is one swappable "character"
function readEnglish(ai) {
  const cands = [];
  for (const c of Array.isArray(ai && ai.en) ? ai.en : []) {
    const code = cleanEnglish(c && c.code);
    if (enProblem(code) || cands.some(x => x.code === code)) continue;
    cands.push({ code, chars: code.split("-").map(wordChar), why: text(c.why, 90) });
  }
  const alts = [0, 1].map(i => {
    const list = Array.isArray(ai && ai.en_alts) && Array.isArray(ai.en_alts[i]) ? ai.en_alts[i] : [];
    return list.map(a => cleanEnglish(typeof a === "string" ? a : a && a.char))
      .filter(w => /^[a-z]{2,12}$/.test(w) && !EN_BLOCK.has(w)).map(wordChar);
  });
  return { cands, alts };
}

const cleanEnglish = v => (typeof v === "string" ? v.trim().toLowerCase().replace(/[\s_]+/g, "-") : "");
const wordChar = w => ({ char: w, name: "", meaning: "" });

// ---- Rules for codes and labels --------------------------------------------------------

function problem(script, code) {
  return script === "zh" ? zhProblem(code) : script === "eg" ? egProblem(code) : script === "em" ? emProblem(code) : enProblem(code);
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

function enProblem(label) {
  if (!EN_RE.test(label || "") || label.length > 20) return "An English label is one or two lowercase words, like night-drive";
  if (EN_BLOCK.has(label) || label.split("-").some(w => EN_BLOCK.has(w))) return "That label uses a word Spotiky doesn't use";
  return null;
}

const hasShapeChar = code => [...code].some(c => ZH_SHAPES[c]);
const shapeOf = code => [...code].map(c => ZH_SHAPES[c] || c).join("");

// ---- Playlists ------------------------------------------------------------------------------

// A playlist's songs written one standard way, or null: "ID1$83,夜光4-8,🌃💡83-105"
function cleanItems(value) {
  if (typeof value !== "string") return null;
  const items = canon(value).trim();   // the same songs with other skin tones are the same playlist
  const tokens = items.split(",");
  if (!items || items.length > 4000 || tokens.length > 100 || !tokens.every(t => ITEM_RE.test(t))) return null;
  return items;
}

async function getPlaylist({ url, request, env }) {
  if (!env.DB) return notSetUp();
  const id = String(url.searchParams.get("id") || "").toLowerCase();
  if (!PLAYLIST_ID_RE.test(id)) return json({ error: "That isn't a playlist link" }, 400);
  const row = await env.DB.prepare(`${WITH_SHELF} WHERE p.id = ?`).bind(id).first();
  if (!row) return json({ error: "No playlist has this link" }, 404);
  if (row.deleted) return json({ error: "Its owner deleted this playlist", deleted: true }, 410);
  const owner = await signedIn(request, env);
  const reply = playlistReply(row, owner, true);
  if (reply.mine) reply.renamesLeft = await renamesLeft(env.DB, id);
  return json(reply);
}

// A playlist with how its owner keeps it, and its liner notes
const WITH_SHELF = `SELECT p.*, s.pinned AS pinned, s.crate AS crate, s.deleted AS deleted, n.notes AS liner
  FROM playlists p LEFT JOIN shelf s ON s.id = p.id LEFT JOIN liner_notes n ON n.list = p.id`;

const parseDetail = d => { try { return JSON.parse(d) || {}; } catch (err) { return {}; } };
const parseList = v => { try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch (err) { return null; } };
const labelCodes = stored => {
  const s = typeof stored === "string" ? JSON.parse(stored) : stored || {};
  return Object.fromEntries(LABELS.filter(k => s[k] && s[k].code).map(k => [k, s[k].code]));
};
const historyRow = (db, list, at, kind, detail) =>
  db.prepare("INSERT INTO playlist_history (list, at, kind, detail) VALUES (?, ?, ?, ?)").bind(list, at, kind, JSON.stringify(detail));
const dayAgo = () => new Date(Date.now() - DAY).toISOString();

async function renamesLeft(db, id) {
  const n = await db.prepare("SELECT COUNT(*) AS n FROM playlist_history WHERE list = ? AND kind = 'rename' AND at > ?").bind(id, dayAgo()).first();
  return Math.max(0, RENAMES_PER_DAY - ((n && n.n) || 0));
}

// The owner's own playlist, ready to change: { row } or { reply } with the reason it can't be
async function ownPlaylist(db, request, env, rawId) {
  const owner = await signedIn(request, env);
  if (!owner) return { reply: json({ error: "Sign in to change your playlist" }, 401) };
  const id = String(rawId || "").toLowerCase();
  if (!PLAYLIST_ID_RE.test(id)) return { reply: json({ error: "That isn't a playlist link" }, 400) };
  const row = await db.prepare(`${WITH_SHELF} WHERE p.id = ?`).bind(id).first();
  if (!row) return { reply: json({ error: "No playlist has this link" }, 404) };
  if (row.owner !== owner) return { reply: json({ error: "Only its owner can change this playlist" }, 403) };
  return { row, owner };
}

async function suggestPlaylist({ body, request, env }) {
  if (!env.DB) return notSetUp();
  const db = env.DB;
  const items = cleanItems(body && body.items);
  if (!items) return json({ error: "Send the playlist's songs" }, 400);
  const hash = await fingerprint(items);
  const owner = await signedIn(request, env);

  // Already saved: your own copy when you're signed in, else the shared snapshot
  if (owner) {
    const own = await db.prepare(`${WITH_SHELF} WHERE p.owner = ? AND p.hash = ? AND s.deleted IS NULL`).bind(owner, hash).first();
    if (own) return json(playlistReply(own, owner));
  }
  const snap = await db.prepare("SELECT * FROM playlists WHERE owner IS NULL AND hash = ?").bind(hash).first();
  if (snap && !owner) return json(playlistReply(snap, null));

  let labels, why = "", about = [];
  if (snap) {
    labels = describeLabels(JSON.parse(snap.labels));   // a signed-in copy of a snapshot starts with its labels
    why = snap.why || "";
    for (const k of LABELS) if (labels[k]) labels[k].saved = false;
  } else {
    if (!env.AI) return json({ error: "Code suggestions aren't set up on this Worker yet" }, 503);
    const songs = await songsFor(items, db);
    if (!songs.length) return json({ error: "Couldn't read these songs from Spotify. Try again in a moment." }, 502);
    about = songs.map(songLabel);
    const built = await askForCodes(env, songs, true, LABELS, await loadWords());
    labels = {};
    for (const k of LABELS) if (built[k].cands.length) labels[k] = { ...withOptions(built[k].cands[0], built[k], false), saved: false };
    if (!Object.keys(labels).length) return json({ error: "Couldn't come up with labels for this one. Try again." }, 502);
    why = (LABELS.map(k => labels[k] && labels[k].why).find(Boolean)) || "";
  }
  // The ID the link will have. A signed-in person's comes with a signature, so saving can keep
  // it without letting anyone pick their own (custom IDs are for paid links later).
  const id = await freshId(db, owner ? randomIds() : snapshotIds(items, hash));
  const reply = { id, labels, why, saved: false, mine: !!owner, owned: !!owner, about };
  if (owner) reply.idSig = await keyed(env, `pid:${owner}:${id}`);
  return json(reply);
}

async function savePlaylist({ body, request, env }) {
  if (!env.DB) return notSetUp();
  const db = env.DB;
  const items = cleanItems(body && body.items);
  if (!items) return json({ error: "Send the playlist's songs" }, 400);
  const hash = await fingerprint(items);
  const at = new Date().toISOString();

  // An owner changing their playlist's songs (and liner notes): the link stays.
  // Its labels change only through /playlist/rename, which has a daily limit.
  if (body.edit) {
    const { row, owner, reply } = await ownPlaylist(db, request, env, body.edit);
    if (reply) return reply;
    if (row.deleted) return json({ error: "This playlist is deleted. Restore it first.", deleted: true }, 410);
    const notes = body.notes === undefined ? null : cleanNotes(body.notes, items);
    if (notes && notes.error) return json(notes, 400);
    const writes = [db.prepare("UPDATE playlists SET items = ?, hash = ?, updated = ? WHERE id = ? AND owner = ?").bind(items, hash, at, row.id, owner)];
    if (notes) writes.push(notesWrite(db, row.id, notes.notes));
    else if (items !== row.items) writes.push(db.prepare("DELETE FROM liner_notes WHERE list = ?").bind(row.id));   // they were for other songs
    if (items !== row.items) writes.push(historyRow(db, row.id, at, "edit", { songs: items.split(",").length }));
    await db.batch(writes);
    const saved = await db.prepare(`${WITH_SHELF} WHERE p.id = ?`).bind(row.id).first();
    return json({ ...playlistReply(saved, owner, true), renamesLeft: await renamesLeft(db, row.id) });
  }

  const owner = await signedIn(request, env);
  if (!(await allow(db, "save:" + (await ipKey(request, env)), 60, HOUR))) {
    return json({ error: "Too many playlists saved from here. Try again in a while." }, 429);
  }
  const labels = cleanLabels(body.labels);
  if (labels.error) return json(labels, 400);
  const row = { items, hash, labels: JSON.stringify(labels.stored), why: labels.why, created: at, updated: at };

  if (owner) {
    const own = await db.prepare(`${WITH_SHELF} WHERE p.owner = ? AND p.hash = ? AND s.deleted IS NULL`).bind(owner, hash).first();
    if (own) return json(playlistReply(own, owner));
    const notes = body.notes === undefined ? null : cleanNotes(body.notes, items);
    if (notes && notes.error) return json(notes, 400);
    const shown = typeof body.id === "string" && typeof body.idSig === "string"
      && sameText(body.idSig, await keyed(env, `pid:${owner}:${body.id}`)) ? [body.id] : [];
    const id = await insertPlaylist(db, { ...row, owner }, withFirst(shown, randomIds()), notes && notes.notes);
    const saved = await db.prepare(`${WITH_SHELF} WHERE p.id = ?`).bind(id).first();
    return json({ ...playlistReply(saved, owner), renamesLeft: RENAMES_PER_DAY });
  }
  // A snapshot: first come, first served, like song codes. Snapshots have no liner notes.
  const snap = await db.prepare("SELECT * FROM playlists WHERE owner IS NULL AND hash = ?").bind(hash).first();
  if (snap) return json(playlistReply(snap, null));
  const id = await insertPlaylist(db, { ...row, owner: null }, snapshotIds(items, hash));
  if (!id) {   // the same snapshot was saved a moment ago
    const again = await db.prepare("SELECT * FROM playlists WHERE owner IS NULL AND hash = ?").bind(hash).first();
    if (again) return json(playlistReply(again, null));
    throw new Error("Couldn't save the playlist");
  }
  return json(playlistReply({ ...row, id, owner: null }, null));
}

async function myPlaylists({ request, env }) {
  if (!env.DB) return notSetUp();
  const owner = await signedIn(request, env);
  if (!owner) return json({ error: "Sign in to see your playlists" }, 401);
  const rows = (await env.DB.prepare(`SELECT p.*, s.pinned AS pinned, s.crate AS crate, n.notes AS liner,
      (SELECT COUNT(*) FROM playlist_history h WHERE h.list = p.id AND h.kind = 'rename' AND h.at > ?) AS renames
    FROM playlists p LEFT JOIN shelf s ON s.id = p.id LEFT JOIN liner_notes n ON n.list = p.id
    WHERE p.owner = ? AND s.deleted IS NULL ORDER BY p.updated DESC LIMIT 300`).bind(dayAgo(), owner).all()).results;
  const playlists = rows.map(r => ({ ...playlistReply(r, owner, true), renamesLeft: Math.max(0, RENAMES_PER_DAY - r.renames) }));
  const crates = [...new Set(playlists.map(p => p.crate).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return json({ playlists, crates, maxPinned: MAX_PINNED, renamesPerDay: RENAMES_PER_DAY });
}

// Saves a playlist under the first free ID it's offered; returns the ID, or null when the
// same snapshot was saved a moment ago
async function insertPlaylist(db, row, ids, notes) {
  for await (const id of ids) {
    const writes = [db.prepare("INSERT INTO playlists (id, items, hash, owner, labels, why, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, row.items, row.hash, row.owner, row.labels, row.why || "", row.created, row.updated)];
    if (row.owner) {
      const s = JSON.parse(row.labels);
      writes.push(historyRow(db, id, row.created, "born", { labels: labelCodes(s), typed: s._typed || [] }));
      if (notes) writes.push(notesWrite(db, id, notes));
    }
    try {
      await db.batch(writes);   // all or nothing
      return id;
    } catch (err) {
      if (!isConflict(err)) throw err;
      if (row.owner === null) {
        const same = await db.prepare("SELECT id FROM playlists WHERE owner IS NULL AND hash = ?").bind(row.hash).first();
        if (same) return null;
      }
      // that ID belongs to another playlist: try the next one
    }
  }
  throw new Error("Couldn't find a free playlist ID");
}

// Snapshot IDs: the start of the playlist's fingerprint, one character longer each time it's
// taken, then the fingerprint of a variation. Starts that spell something rude are skipped.
async function* snapshotIds(items, hash) {
  let h = hash;
  for (let variation = 1; variation <= 20; variation++) {
    for (let len = 3; len <= 13; len++) {
      const id = withDigit(h.slice(0, len));
      if (!rude(id)) yield id;
    }
    h = await fingerprint(items + "\n" + variation);
  }
}

// Own playlists get random IDs: a few tries at each length before going one longer
function* randomIds() {
  for (let len = 3; len <= 13; len++) {
    for (let n = 0; n < (len < 13 ? 6 : 30); n++) {
      const id = withDigit(randomId(len));
      if (!rude(id)) yield id;
    }
  }
}

// An ID made only of letters gets its last letter turned into a digit (the same one each time)
function withDigit(id) {
  if (/[0-9]/.test(id)) return id;
  return id.slice(0, -1) + String(ID_ALPHABET.indexOf(id[id.length - 1]) % 10);
}

async function* withFirst(first, rest) {
  yield* first;
  yield* rest;
}

async function freshId(db, ids) {
  for await (const id of ids) {
    if (!(await db.prepare("SELECT 1 AS x FROM playlists WHERE id = ?").bind(id).first())) return id;
  }
  return null;
}

const rude = id => ID_BLOCK_RE.test(id);

// Labels as sent by the page -> { stored, why } or { error, kind }
function cleanLabels(given) {
  if (!given || typeof given !== "object") return { error: "Send the playlist's labels" };
  const stored = {};
  let why = "";
  for (const k of LABELS) {
    const g = given[k];
    if (!g || typeof g.code !== "string") continue;
    const code = k === "en" ? cleanEnglish(g.code) : k === "em" ? canon(g.code).replace(/\s+/g, "") : g.code.replace(/\s+/g, "");
    const p = problem(k, code);
    if (p) return { error: p, kind: k };
    if (k === "zh") {
      const chars = Array.isArray(g.chars) ? g.chars : [];
      stored.zh = { code, chars: [...code].map((ch, i) => ({ char: ch, meaning: text(chars[i] && chars[i].char === ch ? chars[i].meaning : "", 30) })) };
    } else {
      stored[k] = { code };
    }
    why = why || text(g.why, 90);
  }
  if (!Object.keys(stored).length) return { error: "Send at least one label" };
  // The labels the person wrote themselves, shown in quotes like a name tag on a weapon
  const typed = Array.isArray(given.typed) ? LABELS.filter(k => given.typed.includes(k) && stored[k]) : [];
  if (typed.length) stored._typed = typed;
  return { stored, why };
}

// Liner notes as sent: one per song, in order -> { notes } (null when all are empty) or { error, note }
function cleanNotes(value, items) {
  const count = items.split(",").length;
  if (!Array.isArray(value) || value.length !== count) return { error: "Send one note per song" };
  const notes = [];
  for (let i = 0; i < value.length; i++) {
    const v = typeof value[i] === "string" ? value[i] : "";
    // no control or direction-changing characters; spaces squeezed
    const note = v.replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
    if ([...note].length > NOTE_MAX) return { error: `Note ${i + 1} is longer than ${NOTE_MAX} characters`, note: i };
    const words = note.toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const pairs = words.slice(1).map((w, k) => words[k] + "-" + w);
    if ([...words, ...pairs].some(w => EN_BLOCK.has(w))) return { error: `Note ${i + 1} uses a word Spotiky doesn't use`, note: i };
    notes.push(note);
  }
  return { notes: notes.some(Boolean) ? notes : null };
}

const notesWrite = (db, id, notes) => notes
  ? db.prepare("INSERT INTO liner_notes (list, notes) VALUES (?, ?) ON CONFLICT (list) DO UPDATE SET notes = excluded.notes").bind(id, JSON.stringify(notes))
  : db.prepare("DELETE FROM liner_notes WHERE list = ?").bind(id);

// ---- Naming: a label or code the person typed themselves ---------------------------------
// POST /labels { fixed: {en: "night-drive", zh: "夜歌"}, items | id | track, match }
// Checks what they typed; with match, the AI writes the other kinds to mean the same, each with
// a couple of whole alternatives to reroll through.
async function labelsFor({ body, request, env }) {
  if (!env.DB) return notSetUp();
  const db = env.DB;
  const track = body && typeof body.track === "string" && ID_RE.test(body.track) ? body.track : null;
  const kindsHere = track ? SCRIPTS : LABELS;   // songs have no English codes
  const fixed = {};
  for (const k of kindsHere) {
    const g = body && body.fixed && body.fixed[k];
    if (typeof g !== "string" || !g.trim()) continue;
    const code = k === "en" ? cleanEnglish(g) : k === "em" ? canon(g).replace(/\s+/g, "") : g.replace(/\s+/g, "");
    const p = problem(k, code);
    if (p) return json({ error: p, kind: k, code }, 400);
    fixed[k] = code;
  }
  if (!Object.keys(fixed).length) return json({ error: "Type a label first" }, 400);
  const words = await loadWords();
  const out = {};
  for (const [k, code] of Object.entries(fixed)) out[k] = describeTyped(k, code, words);
  if (!body.match) return json({ labels: out });

  // Matching the other kinds is an AI call
  if (!(await allow(db, "name:" + (await ipKey(request, env)), 60, HOUR))) {
    return json({ error: "A lot of naming from here just now. Try again in a while." }, 429);
  }
  if (!env.AI) return json({ error: "Code suggestions aren't set up on this Worker yet" }, 503);
  let items = track ? null : cleanItems(body && body.items);
  if (!track && !items && typeof body.id === "string" && PLAYLIST_ID_RE.test(body.id.toLowerCase())) {
    const row = await db.prepare("SELECT items FROM playlists WHERE id = ?").bind(body.id.toLowerCase()).first();
    if (row) items = row.items;
  }
  if (!track && !items) return json({ error: "Send the playlist's songs" }, 400);
  const songs = await songsFor(track || items, db);
  if (!songs.length) return json({ error: "Couldn't read these songs from Spotify. Try again in a moment." }, 502);
  const wanted = kindsHere.filter(k => !fixed[k]);
  const built = await askForMatches(env, songs, !track, fixed, out, wanted, words);
  for (const k of wanted) {
    if (!built[k] || !built[k].cands.length) continue;
    const [first, ...rest] = built[k].cands;
    out[k] = { ...withOptions(first, built[k], false), saved: false, matched: true,
      alternates: rest.slice(0, 3).map(c => ({ ...withOptions(c, built[k], false), saved: false, matched: true })) };
  }
  if (!wanted.some(k => out[k])) return json({ error: "Couldn't come up with matching labels. Try again." }, 502);
  const why = wanted.map(k => out[k] && out[k].why).find(Boolean) || "";
  return json({ labels: out, why });
}

// What a typed label looks like on a card: its characters named from our own lists
function describeTyped(k, code, words) {
  const chars = k === "zh" ? [...code].map(ch => ({ char: ch, meaning: "" }))
    : k === "eg" ? [...code].map(glyphChar)
    : k === "em" ? [...code].map(emojiChar)
    : code.split("-").map(wordChar);
  const d = { code, chars, saved: false, typed: true, why: "" };
  if (k === "zh") d.word = wordFor(code, words) || null;
  return d;
}

// Suggestions for the kinds the person didn't write, matched to the one they did
async function askForMatches(env, songs, isPlaylist, fixed, described, kinds, words) {
  const readers = { zh: ai => readChinese(ai, words), eg: readGlyphs, em: readEmoji, en: readEnglish };
  const prompt = buildMatchPrompt(songs, isPlaylist, fixed, kinds);
  const built = Object.fromEntries(kinds.map(s => [s, { cands: [], alts: [] }]));
  await askAI(env, prompt, 1500, ai => {
    fillFrom(built, kinds, readers, ai);
    // The person's own Chinese characters get their meanings from the same answer
    if (fixed.zh && described.zh && Array.isArray(ai.fixed_chars)) {
      for (const c of described.zh.chars) {
        const hit = ai.fixed_chars.find(f => f && f.char === c.char && typeof f.meaning === "string");
        if (hit && !c.meaning) c.meaning = text(hit.meaning, 30);
      }
    }
  }, () => kinds.some(s => !built[s].cands.length));
  return built;
}

const KIND_NAMES = { zh: "Chinese", eg: "hieroglyph", em: "emoji", en: "English" };

function buildMatchPrompt(songs, isPlaylist, fixed, kinds) {
  const what = isPlaylist ? "playlist" : "song";
  const subject = isPlaylist
    ? `a playlist of these songs:\n${songs.map((s, i) => `${i + 1}. ${songLabel(s)}`).join("\n")}`
    : `the song ${songLabel(songs[0])}`;
  const chosen = Object.entries(fixed).map(([k, code]) => `${KIND_NAMES[k]} "${code}"`).join(" and ");
  const parts = [];
  if (kinds.includes("zh")) parts.push(`Chinese: give 3 different codes. Each is 2 common Simplified Chinese characters that read naturally to a Chinese speaker, as a real word or a poetic pair. Avoid slang, rude, unlucky or political readings. Give each character a short English meaning.`);
  if (kinds.includes("eg")) parts.push(`Hieroglyphs: give 3 different codes. Each is 2 signs taken only from this list (sign, name: meaning):\n${GLYPHS.map(g => `${g.c} ${g.name}: ${g.meaning}`).join("\n")}`);
  if (kinds.includes("em")) parts.push(`Emoji: give 3 different codes. Each is 2 emoji, taken only from this list. Leave people and hands in their default color with no skin tone.\n${EMOJI.map(x => x.e).join("")}`);
  if (kinds.includes("en")) parts.push(`English: give 3 different labels. Each is one or two common English words in lowercase, joined by a hyphen when there are two (like "night-drive").`);
  const shapes = [];
  if (kinds.includes("zh")) shapes.push(`"zh":[{"code":"..","chars":[{"char":"..","meaning":".."},{"char":"..","meaning":".."}],"word":null,"why":".."}],\n"zh_alts":[[{"char":"..","meaning":".."}],[{"char":"..","meaning":".."}]]`);
  if (kinds.includes("eg")) shapes.push(`"eg":[{"code":"..","why":".."}],\n"eg_alts":[["..",".."],["..",".."]]`);
  if (kinds.includes("em")) shapes.push(`"em":[{"code":"..","why":".."}],\n"em_alts":[["..",".."],["..",".."]]`);
  if (kinds.includes("en")) shapes.push(`"en":[{"code":"..","why":".."}],\n"en_alts":[["..",".."],["..",".."]]`);
  if (fixed.zh) shapes.push(`"fixed_chars":[{"char":"..","meaning":".."},{"char":"..","meaning":".."}]`);
  return `The person sharing ${subject} named it themselves: their label is ${chosen}.

Make codes in the other kinds below that mean what their label means, fitted to the ${what}. Capture the same image or feeling, not a translation word by word, and never quote lyrics.

${parts.join("\n\n")}

For every kind, also give 4 alternatives for each position of your first code: characters, signs, emoji or words that would also fit in that spot.
Write each "why" as one short English line, under 12 words, linking their label to the ${what}.${fixed.zh ? `\nAlso give a short English meaning for each character of their Chinese label ${fixed.zh}, as "fixed_chars".` : ""}

Reply with JSON only, in exactly this shape:
{${shapes.join(",\n")}}`;
}

// ---- Your collection: renaming, the shelf, deleting ------------------------------------------

// POST /playlist/rename { id, labels, typed }: new labels for an owner's playlist, a few times a
// day. Its ID and links stay; an old label in a link still opens it.
async function renamePlaylist({ body, request, env }) {
  if (!env.DB) return notSetUp();
  const db = env.DB;
  const { row, owner, reply } = await ownPlaylist(db, request, env, body && body.id);
  if (reply) return reply;
  if (row.deleted) return json({ error: "This playlist is deleted. Restore it first.", deleted: true }, 410);
  const labels = cleanLabels({ ...((body && body.labels) || {}), typed: body && body.typed });
  if (labels.error) return json(labels, 400);
  const before = typeof row.labels === "string" ? JSON.parse(row.labels) : row.labels;
  const left = await renamesLeft(db, row.id);
  const same = JSON.stringify(labelCodes(before)) === JSON.stringify(labelCodes(labels.stored))
    && JSON.stringify(before._typed || []) === JSON.stringify(labels.stored._typed || []);
  if (same) return json({ ...playlistReply(row, owner, true), renamesLeft: left, unchanged: true });
  if (left <= 0) {
    const first = await db.prepare("SELECT MIN(at) AS at FROM playlist_history WHERE list = ? AND kind = 'rename' AND at > ?").bind(row.id, dayAgo()).first();
    const nextAt = first && first.at ? new Date(Date.parse(first.at) + DAY).toISOString() : null;
    return json({ error: `You've renamed this playlist ${RENAMES_PER_DAY} times today. Try again tomorrow.`, renamesLeft: 0, nextAt }, 429);
  }
  // Chinese meanings the person didn't send stay from before, when the characters are the same
  if (labels.stored.zh && before.zh && labels.stored.zh.code === before.zh.code) {
    labels.stored.zh.chars = labels.stored.zh.chars.map((c, i) => c.meaning ? c : { ...c, meaning: (before.zh.chars && before.zh.chars[i] && before.zh.chars[i].meaning) || "" });
  }
  const at = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE playlists SET labels = ?, why = ?, updated = ? WHERE id = ? AND owner = ?")
      .bind(JSON.stringify(labels.stored), labels.why || row.why || "", at, row.id, owner),
    historyRow(db, row.id, at, "rename", { from: labelCodes(before), to: labelCodes(labels.stored), typed: labels.stored._typed || [] }),
  ]);
  const saved = await db.prepare(`${WITH_SHELF} WHERE p.id = ?`).bind(row.id).first();
  return json({ ...playlistReply(saved, owner, true), renamesLeft: left - 1 });
}

// POST /playlist/shelf { id, pinned?, crate? }: pin to the featured shelf, or move into a crate
async function shelvePlaylist({ body, request, env }) {
  if (!env.DB) return notSetUp();
  const db = env.DB;
  const { row, owner, reply } = await ownPlaylist(db, request, env, body && body.id);
  if (reply) return reply;
  if (row.deleted) return json({ error: "This playlist is deleted. Restore it first.", deleted: true }, 410);
  let pinned = row.pinned || null, crate = row.crate || null;
  if (body.pinned === true && !pinned) {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM shelf WHERE owner = ? AND pinned IS NOT NULL AND deleted IS NULL").bind(owner).first();
    if (n && n.n >= MAX_PINNED) return json({ error: `Your featured shelf holds ${MAX_PINNED}. Unpin one first.`, full: true }, 409);
    pinned = new Date().toISOString();
  } else if (body.pinned === false) {
    pinned = null;
  }
  if (body.crate !== undefined) {
    crate = typeof body.crate === "string"
      ? body.crate.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, 24) || null
      : null;
  }
  await shelfWrite(db, row.id, owner, pinned, crate, null).run();
  return json({ id: row.id, pinned: !!pinned, crate });
}

const shelfWrite = (db, id, owner, pinned, crate, deleted) =>
  db.prepare(`INSERT INTO shelf (id, owner, pinned, crate, deleted) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET pinned = excluded.pinned, crate = excluded.crate, deleted = excluded.deleted`)
    .bind(id, owner, pinned, crate, deleted);

// POST /playlist/delete { id }: it leaves the collection and its links stop working. The ID is
// never given to another playlist, so /playlist/restore can bring it back as it was.
async function deletePlaylist({ body, request, env }) {
  if (!env.DB) return notSetUp();
  const { row, owner, reply } = await ownPlaylist(env.DB, request, env, body && body.id);
  if (reply) return reply;
  await shelfWrite(env.DB, row.id, owner, null, row.crate || null, row.deleted || new Date().toISOString()).run();
  return json({ id: row.id, deleted: true });
}

async function restorePlaylist({ body, request, env }) {
  if (!env.DB) return notSetUp();
  const { row, owner, reply } = await ownPlaylist(env.DB, request, env, body && body.id);
  if (reply) return reply;
  await shelfWrite(env.DB, row.id, owner, null, row.crate || null, null).run();
  const saved = await env.DB.prepare(`${WITH_SHELF} WHERE p.id = ?`).bind(row.id).first();
  return json({ ...playlistReply(saved, owner, true), renamesLeft: await renamesLeft(env.DB, row.id) });
}

// GET /playlist/history?id=: when it was made, renamed and edited. Anyone can see a playlist's trail.
async function playlistHistory({ url, env }) {
  if (!env.DB) return notSetUp();
  const id = String(url.searchParams.get("id") || "").toLowerCase();
  if (!PLAYLIST_ID_RE.test(id)) return json({ error: "That isn't a playlist link" }, 400);
  const row = await env.DB.prepare(`${WITH_SHELF} WHERE p.id = ?`).bind(id).first();
  if (!row) return json({ error: "No playlist has this link" }, 404);
  if (row.deleted) return json({ error: "Its owner deleted this playlist", deleted: true }, 410);
  const rows = (await env.DB.prepare("SELECT at, kind, detail FROM playlist_history WHERE list = ? ORDER BY at DESC, rowid DESC LIMIT 50").bind(id).all()).results;
  return json({ id, created: row.created, history: rows.map(h => ({ at: h.at, kind: h.kind, ...parseDetail(h.detail) })) });
}

// GET /codes/mine: the song codes this person saved while signed in
async function myCodes({ request, env }) {
  if (!env.DB) return notSetUp();
  const owner = await signedIn(request, env);
  if (!owner) return json({ error: "Sign in to see your codes" }, 401);
  const rows = (await env.DB.prepare(`SELECT c.code, c.script, c.track, c.chars, c.word, c.why, n.at
    FROM namers n JOIN song_codes c ON c.code = n.code WHERE n.owner = ? ORDER BY n.at DESC LIMIT 500`).bind(owner).all()).results;
  return json({
    codes: rows.map(r => ({
      code: r.code, script: r.script, track: r.track, at: r.at, why: r.why || "", word: r.word || null,
      chars: r.script === "zh" ? parseChars(r.chars, r.code) : [...r.code].map(r.script === "eg" ? glyphChar : emojiChar),
    })),
  });
}

// GET /sets: the hieroglyph signs and emoji codes and labels can use, for the pickers
async function sets() {
  return json({
    glyphs: GLYPHS.map(g => ({ c: g.c, name: g.name, meaning: g.meaning })),
    emoji: EMOJI.map(x => ({ e: x.e, name: x.name, toneable: TONEABLE.has(x.e) })),
  }, 200, { "Cache-Control": "public, max-age=86400" });
}

function describeLabels(stored) {
  const out = {};
  for (const k of LABELS) {
    const s = stored && stored[k];
    if (!s || typeof s.code !== "string") continue;
    const chars = k === "zh" ? parseChars(JSON.stringify(s.chars || []), s.code)
      : k === "eg" ? [...s.code].map(glyphChar)
      : k === "em" ? [...s.code].map(emojiChar)
      : s.code.split("-").map(wordChar);
    out[k] = { code: s.code, chars, saved: true };
  }
  return out;
}

function playlistReply(row, owner, withItems) {
  const stored = typeof row.labels === "string" ? JSON.parse(row.labels) : row.labels;
  const mine = !!owner && row.owner === owner;
  const reply = {
    id: row.id,
    labels: describeLabels(stored),
    typed: (stored && stored._typed) || [],
    why: row.why || "",
    saved: true,
    mine,
    owned: !!row.owner,
    created: row.created,
    updated: row.updated,
  };
  if (withItems) {
    reply.items = row.items;
    const notes = row.liner ? parseList(row.liner) : null;
    if (notes && notes.length === row.items.split(",").length) reply.notes = notes;
  }
  if (mine) {
    reply.pinned = !!row.pinned;
    reply.crate = row.crate || null;
  }
  return reply;
}

// ---- Accounts: email + a 6-digit code ----------------------------------------------------------

async function startSignIn({ body, request, env }) {
  if (!env.DB || !env.PEPPER || !env.RESEND_API_KEY) return json({ error: "Sign-in isn't set up on this Worker yet" }, 503);
  const db = env.DB;
  const email = cleanEmail(body && body.email);
  if (!email) return json({ error: "Enter a valid email address" }, 400);
  const who = await keyed(env, "email:" + email);
  const ip = await ipKey(request, env);
  // 3 codes per email per 15 minutes, 10 per connection per hour, 90 a day in all (Resend's free plan sends 100)
  if (!(await allow(db, "code:" + who, 3, 15 * MINUTE)) || !(await allow(db, "code-ip:" + ip, 10, HOUR))) {
    return json({ error: "Too many codes asked for. Wait a few minutes and try again." }, 429);
  }
  if (!(await allow(db, "code-all", 90, DAY))) {
    return json({ error: "Sign-in emails are paused for today. Try again tomorrow." }, 429);
  }
  const code = sixDigits();
  await db.prepare(`INSERT INTO sign_in_codes (email, code, expires, tries) VALUES (?, ?, ?, 0)
                    ON CONFLICT (email) DO UPDATE SET code = excluded.code, expires = excluded.expires, tries = 0`)
    .bind(who, await keyed(env, `code:${who}:${code}`), Date.now() + CODE_MINUTES * MINUTE).run();
  if (!(await sendCode(env, email, code))) return json({ error: "Couldn't send the email. Try again in a moment." }, 502);
  return json({ sent: true, minutes: CODE_MINUTES });
}

async function verifySignIn({ body, env }) {
  if (!env.DB || !env.PEPPER) return json({ error: "Sign-in isn't set up on this Worker yet" }, 503);
  const db = env.DB;
  const email = cleanEmail(body && body.email);
  const code = String((body && body.code) || "").replace(/\D/g, "");
  if (!email || code.length !== 6) return json({ error: "Enter the 6-digit code from the email" }, 400);
  const who = await keyed(env, "email:" + email);
  const row = await db.prepare("SELECT code, expires, tries FROM sign_in_codes WHERE email = ?").bind(who).first();
  if (!row || row.expires < Date.now()) return json({ error: "That code has expired. Ask for a new one.", expired: true }, 400);
  if (row.tries >= CODE_TRIES) return json({ error: "Too many wrong tries. Ask for a new code.", expired: true }, 429);
  const hashed = await keyed(env, `code:${who}:${code}`);
  if (!sameText(row.code, hashed)) {
    await db.prepare("UPDATE sign_in_codes SET tries = tries + 1 WHERE email = ?").bind(who).run();
    return json({ error: "That code isn't right", triesLeft: Math.max(0, CODE_TRIES - row.tries - 1) }, 400);
  }
  // The code works once: whoever removes it first is the one signed in
  const used = await db.prepare("DELETE FROM sign_in_codes WHERE email = ? AND code = ?").bind(who, hashed).run();
  if (!used.meta || used.meta.changes !== 1) return json({ error: "That code was just used. Ask for a new one.", expired: true }, 400);
  // The account is made the first time someone signs in with this email
  await db.prepare("INSERT INTO owners (id, email, created) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING")
    .bind(randomId(16), who, new Date().toISOString()).run();
  const owner = await db.prepare("SELECT id FROM owners WHERE email = ?").bind(who).first();
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * DAY;
  await db.prepare("INSERT INTO sessions (token, owner, expires) VALUES (?, ?, ?)").bind(await sha256hex(token), owner.id, expires).run();
  return json({ token, expires });
}

async function me({ request, env }) {
  if (!env.DB) return notSetUp();
  const owner = await signedIn(request, env);
  if (!owner) return json({ signedIn: false }, 401);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM playlists WHERE owner = ?").bind(owner).first();
  return json({ signedIn: true, playlists: row ? row.n : 0 });
}

async function signOut({ request, env }) {
  if (!env.DB) return notSetUp();
  const token = bearer(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(await sha256hex(token)).run();
  return json({ signedOut: true });
}

// The account behind this request's sign-in, or null
async function signedIn(request, env) {
  const token = bearer(request);
  if (!token || !env.DB) return null;
  const row = await env.DB.prepare("SELECT owner, expires FROM sessions WHERE token = ?").bind(await sha256hex(token)).first();
  return row && row.expires > Date.now() ? row.owner : null;
}

function bearer(request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+([A-Za-z0-9_-]{20,100})$/);
  return m ? m[1] : null;
}

async function sendCode(env, email, code) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: env.EMAIL_FROM || FROM,
        to: [email],
        subject: `Your Spotiky code: ${code}`,
        text: `Your Spotiky sign-in code is ${code}\n\nIt works for ${CODE_MINUTES} minutes. If you didn't ask for it, you can ignore this email.`,
      }),
    });
    if (!res.ok) {
      // Resend's reason, for the Worker's logs (npx wrangler tail). Only the kind of error: its
      // message can include the email address, and emails are never kept.
      const why = await res.json().catch(() => ({}));
      console.log(`Resend didn't send a sign-in code: ${res.status} ${why.name || ""}`.trim());
    }
    return res.ok;
  } catch (err) {
    console.log("Couldn't reach Resend: " + (err && err.message));
    return false;
  }
}

function cleanEmail(value) {
  const e = String(value || "").trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// Rate limits: allows `limit` events per `windowMs` for a key, counting this one
async function allow(db, key, limit, windowMs) {
  const now = Date.now();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM sends WHERE key = ? AND at > ?").bind(key, now - windowMs).first();
  if (row && row.n >= limit) return false;
  await db.prepare("INSERT INTO sends (key, at) VALUES (?, ?)").bind(key, now).run();
  if (Math.random() < 0.02) await db.prepare("DELETE FROM sends WHERE at < ?").bind(now - 2 * DAY).run();
  return true;
}

// Where a request comes from, hashed so no IP address is ever stored
const ipKey = (request, env) => keyed(env, "ip:" + (request.headers.get("CF-Connecting-IP") || "unknown"));

// ---- Song details ------------------------------------------------------------------------

// Up to 8 songs to describe: a song ID, or a playlist's songs (codes looked up)
async function songsFor(itemsOrId, db) {
  const ids = [];
  for (const token of String(itemsOrId).split(",")) {
    if (ids.length >= 8) break;
    const id = token.slice(0, 22);
    if (ID_RE.test(id)) { ids.push(id); continue; }
    const row = await db.prepare("SELECT track FROM song_codes WHERE code = ?").bind(canon(token.replace(/[\d-]+$/, ""))).first();
    if (row) ids.push(row.track);
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
  const data = await oembedData(id);
  return data && typeof data.title === "string" && data.title.trim() ? data.title.trim() : null;
}

// Spotify's oEmbed answer for a song: its title and a 300px cover
async function oembedData(id) {
  try {
    const page = encodeURIComponent(`https://open.spotify.com/track/${id}`);
    const res = await fetch(`https://open.spotify.com/oembed?url=${page}`, { headers: { "User-Agent": UA } });
    return res.ok ? await res.json() : null;
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

// ---- Previews ----------------------------------------------------------------------------

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

// ---- spotiky.com: pages with link previews ----------------------------------------------------
// The Worker also runs in front of GitHub Pages on spotiky.com (the route in wrangler.jsonc).
// GitHub Pages answers every page address (/track/ID$13-44, /夜光83-105, /playlist/5mh夜歌)
// with 404.html, which is the page itself sent with status 404, and Discord, iMessage,
// WhatsApp, Slack and X show no preview for a 404. So for those addresses the Worker sends the
// same page with status 200, with the song's title, artist, cover and clip times in its <head>.
// Everything else (the home page, collection.js, the resume and site folders) passes straight
// through, and if anything here fails, the request goes on to GitHub Pages as if the Worker
// weren't there.
//
// What Discord shows for spotiky.com/track/ID$13-44:
//   Spotiky                        site name (from the oEmbed answer below)
//   The Weeknd                     artist, linked to their Spotify page
//   Blinding Lights                song title, linked to the Spotiky page
//   Clip 0:13–0:44 · 夜光 · 🌃💡    the times, then the song's codes
//   [cover]                        640px cover art; the stripe beside it takes the cover's color

const SITE = "https://spotiky.com";
const SITE_HOSTS = new Set(["spotiky.com", "www.spotiky.com", "open.spotiky.com"]);
const GREEN = "#1DB954";
const GONE = { gone: true };   // a playlist its owner deleted
// Preview fetchers get the whole card; a person opening the page waits no longer than PERSON_WAIT
const PREVIEW_BOTS = /bot|crawl|spider|preview|externalhit|facebot|whatsapp|telegram|slack|discord|skype|teams|linkedin|embedly|iframely|pinterest|snapchat|kakao|line\/|mastodon|http\.rb|bluesky|cardyb|curl|wget|python|go-http|okhttp|java\//i;
const BOT_WAIT = 4000, PERSON_WAIT = 700;   // milliseconds; Discord gives a whole preview 10 seconds
const MAKER_CARD = { type: "website", title: "Make a playlist on Spotiky", description: "Line up songs and clips, then share them as one link." };
const ACCOUNT_CARD = { type: "website", title: "Your Spotiky collection", description: "Your playlists, the codes you named and your clips." };
// The collection page's sleeve colors, so a playlist's preview matches its sleeve
const SLEEVES = ["#2b4c7e", "#7a2e3b", "#1f5c4a", "#5b3a82", "#b8532c", "#233d3f", "#8a6d1f", "#2f2f2f", "#3e5f8a", "#6b4f3a", "#1d4b2c", "#4a2545"];
const hashOf = s => { let x = 2166136261; for (const c of String(s)) x = Math.imul(x ^ c.codePointAt(0), 16777619); return x >>> 0; };

// Links as the page reads them (index.html): a time is 83, 1:23, 1.23 or 1:02:03, and a clip
// adds "-end". Codes take their times right after the code: /夜光83-105, /track/夜光1:23-1:45
const TIME = String.raw`\d+(?:[.:,]\d+)*`;
const RANGE = String.raw`(${TIME})(?:-[$.]?(${TIME}))?`;
const RANGE_RE = new RegExp(String.raw`(?:\$|[?&]t=|^\.)` + RANGE, "i");     // …$83  …&t=1:23  ID.83
const TRAILING_RE = new RegExp(String.raw`\.` + RANGE + String.raw`\/?$`);    // …?si=abc.83
const CODE_RANGE_RE = new RegExp(String.raw`^(?:\$|[?&]t=|\.)?` + RANGE, "i");
const CODE_CHARS = String.raw`\p{Script=Han}\p{Script=Egyptian_Hieroglyphs}\p{Emoji_Presentation}`;
const CODE_IN_PATH_RE = new RegExp(String.raw`^\/(?:track\/)?([${CODE_CHARS}]+)(.*)$`, "u");
const CODE_START_RE = new RegExp(String.raw`^([${CODE_CHARS}]+)`, "u");
const PLAYLIST_LINK_RE = /^(?=[0-9a-hjkmnp-tv-z]{0,12}[0-9])([0-9a-hjkmnp-tv-z]{3,13})(?=$|-|[^\x00-\x7F])(.*)$/iu;

// GitHub Pages tells caches to keep the page for ten minutes, so a push can hide behind that
// cache for ten minutes. A throwaway query on the subrequest keeps it out of the cache; the
// browser never sees it.
const fresh = request => {
  const u = new URL(request.url);
  u.searchParams.set("_", Date.now().toString(36));
  return fetch(new Request(u.toString(), request));
};

async function site(request, env, ctx, url) {
  if (ctx && ctx.passThroughOnException) ctx.passThroughOnException();   // an error here still shows the page
  if (url.hostname !== "spotiky.com") return Response.redirect(SITE + url.pathname + url.search, 301);
  if (url.pathname === "/oembed") return oembedFor(url, env);
  const route = (request.method === "GET" || request.method === "HEAD") && pageRoute(url);
  if (!route) return fresh(request);
  try {
    const bot = PREVIEW_BOTS.test(request.headers.get("User-Agent") || "");
    const card = previewFor(route, env).catch(() => undefined);
    if (ctx && ctx.waitUntil) ctx.waitUntil(card);   // it finishes, and fills the caches, after a timed-out page has gone out
    const [page, found] = await Promise.all([
      fresh(request.method === "HEAD" ? new Request(request, { method: "GET" }) : request),
      within(card, bot ? BOT_WAIT : PERSON_WAIT),
    ]);
    return await withCard(page, found === undefined ? fallbackCard(route) : found, request, url);
  } catch (err) {
    return fresh(request);
  }
}

// Resolves to what the promise gives, or undefined once ms have gone by
const within = (promise, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(undefined), ms);
  promise.then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(undefined); });
});

// Which page an address is, read the way index.html reads it; null for everything else
function pageRoute(url) {
  const path = decodeSafe(url.pathname);
  const full = path + decodeSafe(url.search);   // a time can sit in the query: /track/ID?si=abc&t=1:23
  if (/^\/account\/?$/i.test(path)) return { kind: "page", card: ACCOUNT_CARD };
  const pl = path.match(/^\/playlist(?:\/(.*))?$/i);
  if (pl) {
    const list = (pl[1] || "").replace(/\/+$/, "");
    if (!list) return { kind: "page", card: MAKER_CARD };
    if (/^[a-zA-Z0-9]{22}$/.test(list)) return null;   // a Spotify playlist's own ID: not playable on Spotiky yet
    const link = list.match(PLAYLIST_LINK_RE);
    if (link) return { kind: "list", id: link[1].toLowerCase(), label: link[2] };
    const pieces = listPieces(list);
    return pieces.length ? { kind: "items", pieces } : null;
  }
  const coded = stripVS(full).match(CODE_IN_PATH_RE);
  if (coded) return { kind: "code", code: coded[1], ...codeRangeIn(coded[2]) };
  const track = full.match(/^\/track\/([a-zA-Z0-9]{22})/);
  if (track) return { kind: "track", id: track[1], ...rangeIn(full.slice(track[0].length)) };
  // The oldest links: spotiky.com/?track=ID&t=83
  const old = path === "/" && url.searchParams.get("track");
  const oldId = old && (old.match(/(?:track[/:])([a-zA-Z0-9]{22})/) || old.match(/^([a-zA-Z0-9]{22})$/));
  if (oldId) return { kind: "track", id: oldId[1], ...rangeIn("&t=" + (url.searchParams.get("t") || "0")) };
  return null;
}

function rangeIn(rest) {
  const m = rest.match(RANGE_RE) || rest.match(TRAILING_RE);
  return m ? { start: m[1], end: m[2] || null } : { start: null, end: null };
}

function codeRangeIn(rest) {
  const m = String(rest).match(CODE_RANGE_RE);
  return m ? { start: m[1], end: m[2] || null } : { start: null, end: null };
}

// A playlist link's songs: ID1$83,夜光1:23-1:45,ID3. A piece that's only a time, like the
// "23" in 夜光1,23, is a decimal comma, not a new song.
function listPieces(list) {
  const out = [];
  for (const piece of list.split(",")) {
    if (!piece) continue;
    if (out.length && /^[\d.:,\-$]{1,12}$/.test(piece)) out[out.length - 1] += "," + piece;
    else out.push(piece);
  }
  return out;
}

// The card for a page: an object, null when there's no such code or playlist, or GONE
async function previewFor(route, env) {
  const db = env.DB;
  if (route.kind === "page") return route.card;
  if (route.kind === "track") return trackCard(route, null, db);
  if (!db) throw new Error("No database");
  if (route.kind === "code") {
    const id = await trackForCode(db, route.code);
    return id ? trackCard({ ...route, id }, route.code, db) : null;
  }
  if (route.kind === "list") {
    const row = await db.prepare(`SELECT p.items AS items, p.labels AS labels, s.deleted AS deleted
      FROM playlists p LEFT JOIN shelf s ON s.id = p.id WHERE p.id = ?`).bind(route.id).first();
    if (!row) return null;
    if (row.deleted) return GONE;
    let stored = {};
    try { stored = JSON.parse(row.labels) || {}; } catch (err) { /* no labels to show */ }
    return playlistCard(row.items.split(","), db, listName(stored, route.label), hashOf(route.id));
  }
  return playlistCard(route.pieces, db, null, hashOf(route.pieces.join(",")));
}

async function trackCard({ id, start, end }, linkCode, db) {
  const [song, codes] = await Promise.all([songDetails(id), db ? songCodesFor(db, id).catch(() => []) : []]);
  const shown = [];
  for (const c of [linkCode, ...codes]) if (c && !shown.some(s => canon(s) === canon(c))) shown.push(c);
  const description = [clipText(start, end), ...shown].join(" · ");
  if (!song) return { type: "music.song", title: "Play this song on Spotiky", description, color: GREEN };
  return {
    type: "music.song",
    title: song.title,
    description,
    author: song.artist ? { name: song.artist, url: song.artistUrl } : null,
    image: song.image ? { ...song.image, alt: `Cover art for ${song.title}` } : null,
    color: song.color || GREEN,
  };
}

// The first three songs by name, the first cover, and the sleeve color
async function playlistCard(pieces, db, name, seed) {
  const n = pieces.length;
  const songsWord = `${n} ${n === 1 ? "song" : "songs"}`;
  const ids = await Promise.all(pieces.slice(0, 3).map(p => trackOf(p, db).catch(() => null)));
  const named = (await Promise.all(ids.map(id => (id ? songDetails(id) : null)))).filter(Boolean);
  const cover = named.find(s => s.image);
  const more = n - named.length;
  return {
    type: "music.playlist",
    title: name || "A Spotiky playlist",
    description: named.length ? named.map(s => s.title).join(" · ") + (more > 0 ? ` + ${more} more` : "") : `${songsWord} that play one after another`,
    author: { name: `Playlist · ${songsWord}` },
    image: cover ? { ...cover.image, alt: `Cover art for ${cover.title}` } : null,
    color: brighten(SLEEVES[seed % SLEEVES.length]),
  };
}

// While the song details are still on their way, a card that needs none of them
function fallbackCard(route) {
  if (route.kind === "page") return route.card;
  if (route.kind === "track" || route.kind === "code") {
    return { type: "music.song", title: "Play this song on Spotiky", description: [clipText(route.start, route.end), route.code].filter(Boolean).join(" · "), color: GREEN };
  }
  return { type: "music.playlist", title: "A Spotiky playlist", description: "Songs and clips that play one after another.", color: GREEN };
}

// The playlist's name as its link shows it: the label of the link's kind, else the one its
// owner typed, else emoji, Chinese, English, hieroglyphs. Typed names keep their quotes.
function listName(stored, urlLabel) {
  const typed = Array.isArray(stored._typed) ? stored._typed : [];
  const has = k => k && stored[k] && typeof stored[k].code === "string" && stored[k].code;
  const kind = [labelKind(String(urlLabel || "").replace(/^-/, "")), ...typed, "em", "zh", "en", "eg"].find(has);
  if (!kind) return null;
  return typed.includes(kind) ? `“${stored[kind].code}”` : stored[kind].code;
}

function labelKind(s) {
  if (!s) return null;
  if (/\p{Script=Han}/u.test(s)) return "zh";
  if (/\p{Script=Egyptian_Hieroglyphs}/u.test(s)) return "eg";
  if (/\p{Emoji_Presentation}/u.test(s)) return "em";
  return /^[a-z]/i.test(s) ? "en" : null;
}

async function trackOf(piece, db) {
  const id = piece.match(/^[a-zA-Z0-9]{22}/);
  if (id) return id[0];
  const code = stripVS(piece).match(CODE_START_RE);
  return code && db ? trackForCode(db, code[1]) : null;
}

async function trackForCode(db, code) {
  const row = await db.prepare("SELECT track FROM song_codes WHERE code = ?").bind(canon(code)).first();
  return row ? row.track : null;
}

// A song's Chinese and emoji codes. Hieroglyphs are left out: many phones can't show them.
async function songCodesFor(db, id) {
  const { results } = await db.prepare("SELECT code, script FROM song_codes WHERE track = ? AND script IN ('zh', 'em')").bind(id).all();
  return ["zh", "em"].map(s => (results.find(r => r.script === s) || {}).code).filter(Boolean);
}

// "Clip 0:13–0:44", "Starts at 1:23" or "Full song"
function clipText(start, end) {
  const s = start ? parseTime(start) : 0;
  const e = end != null && end !== "" ? parseTime(end) : null;
  if (e != null && e > s) return `Clip ${formatTime(s)}–${formatTime(e)}`;
  return s > 0 ? `Starts at ${formatTime(s)}` : "Full song";
}

// The page's own time reading: 83, 1:23, 1.23, 1:02:03 -> seconds
function parseTime(t) {
  if (!t) return 0;
  t = String(t).trim().replace(",", ".").replace(/^(?:\$|[?&]?t=)/i, "");
  if (t.includes(":")) {
    const parts = t.split(":").map(p => parseFloat(p) || 0);
    if (parts.length === 2) return Math.floor(parts[0] * 60 + parts[1]);
    if (parts.length === 3) return Math.floor(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  if (t.includes(".")) {
    const [m, s] = t.split(".").map(p => parseFloat(p) || 0);
    return Math.floor(m * 60 + s);
  }
  return parseInt(t, 10) || 0;
}

function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60;
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch (err) { return s; }
}

// Song details for previews, kept an hour in this Worker's memory and a week in Cloudflare's
// cache, so Discord's two fetches (the page, then its oEmbed) ask Spotify once
const songMemo = new Map();
function songDetails(id) {
  const hit = songMemo.get(id);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const entry = { at: Date.now(), ttl: HOUR, value: cachedSong(id).catch(() => null) };
  entry.value.then(song => { if (!song) entry.ttl = MINUTE; });   // try Spotify again soon
  songMemo.set(id, entry);
  if (songMemo.size > 500) songMemo.delete(songMemo.keys().next().value);
  return entry.value;
}

async function cachedSong(id) {
  const cache = typeof caches !== "undefined" && caches.default;
  const key = `${SITE}/.song/${id}`;
  const kept = cache && (await cache.match(key).catch(() => null));
  if (kept) return kept.json();
  const song = await songFromSpotify(id);
  if (song && cache) {
    await cache.put(key, new Response(JSON.stringify(song), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=604800" },
    })).catch(() => {});
  }
  return song;
}

async function songFromSpotify(id) {
  const [oe, html] = await Promise.all([oembedData(id), embedPage(id)]);
  const title = (oe && typeof oe.title === "string" && oe.title.trim()) || (html && titleIn(html));
  if (!title) return null;
  return {
    title,
    artist: (html && artistsIn(html)) || null,
    artistUrl: (html && artistUrlIn(html)) || null,
    image: (html && coverIn(html)) || coverFrom(oe),
    color: (html && colorIn(html)) || null,
  };
}

// The largest cover on the embed page: its data lists 64, 300 and 640px sizes
function coverIn(html) {
  const at = html.indexOf('"coverArt"');
  const list = at >= 0 && html.slice(at, at + 3000).match(/"sources":\s*\[([^\]]*)\]/);
  if (!list) return null;
  let best = null;
  for (const item of list[1].split("}")) {
    const url = item.match(/"url":\s*"(https:[^"]+)"/);
    const width = Number((item.match(/"width":\s*(\d+)/) || [])[1]) || 0;
    const height = Number((item.match(/"height":\s*(\d+)/) || [])[1]) || 0;
    if (url && (!best || width > best.width)) best = { url: unjson(url[1]), width, height };
  }
  if (!best) return null;
  return best.width && best.height ? best : { url: best.url };
}

// oEmbed's 300px cover, swapped for the 640px one when it's a standard Spotify cover address
function coverFrom(oe) {
  const url = oe && typeof oe.thumbnail_url === "string" && /^https:\/\//.test(oe.thumbnail_url) ? oe.thumbnail_url : null;
  if (!url) return null;
  if (url.includes("ab67616d00001e02")) return { url: url.replace("ab67616d00001e02", "ab67616d0000b273"), width: 640, height: 640 };
  const width = Number(oe.thumbnail_width) || 0, height = Number(oe.thumbnail_height) || 0;
  return width && height ? { url, width, height } : { url };
}

function artistUrlIn(html) {
  const list = html.match(/"artists":\s*\[([^\]]*)\]/);
  const m = (list && list[1].match(/spotify:artist:([A-Za-z0-9]{22})/)) || html.match(/\/artist\/([A-Za-z0-9]{22})/);
  return m ? `https://open.spotify.com/artist/${m[1]}` : null;
}

// The color Spotify picked from the cover (not its grey stand-in), made light enough to see
function colorIn(html) {
  const m = html.match(/"colorDark":\s*\{\s*"hex":\s*"(#[0-9A-Fa-f]{6})"\s*(?:,\s*"isFallback":\s*(true|false))?/);
  return m && m[2] !== "true" ? brighten(m[1]) : null;
}

// The same hue, raised to half lightness when darker, so the stripe beside a preview shows on
// Discord's dark and light themes alike
function brighten(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (l >= 0.5) return hex.toLowerCase();
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  const c = s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = 0.5 - c / 2;   // lightness 0.5
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = v => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r1)}${to(g1)}${to(b1)}`;
}

// GitHub Pages' answer with the card in its <head> and status 200 (410 for a deleted playlist;
// a code or playlist that doesn't exist keeps its 404)
async function withCard(page, card, request, url) {
  const ours = (page.status === 404 || page.status === 200) && /text\/html/i.test(page.headers.get("Content-Type") || "");
  if (!ours || card === null) return page;
  if (card === GONE) return new Response(page.body, { status: 410, headers: page.headers });
  const html = await page.text();
  const headers = new Headers(page.headers);
  for (const h of ["Content-Length", "Content-Encoding", "ETag", "Last-Modified"]) headers.delete(h);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  const body = withHead(html, previewHead(card, SITE + url.pathname + url.search));
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers });
}

function previewHead(card, pageUrl) {
  const tags = [
    ["property", "og:site_name", "Spotiky"],
    ["property", "og:type", card.type || "website"],
    ["property", "og:url", pageUrl],
    ["property", "og:title", card.title],
    ["property", "og:description", card.description],
    ["name", "description", card.description],
  ];
  if (card.image) {
    tags.push(["property", "og:image", card.image.url]);
    if (card.image.width && card.image.height) tags.push(["property", "og:image:width", card.image.width], ["property", "og:image:height", card.image.height]);
    tags.push(["property", "og:image:alt", card.image.alt]);
  }
  tags.push(["name", "twitter:card", card.image ? "summary_large_image" : "summary"]);
  tags.push(["name", "theme-color", card.color || GREEN]);
  const lines = tags.filter(t => t[2] != null && t[2] !== "").map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escAttr(value)}">`);
  // Discord takes the artist line and the linked site name from this
  lines.push(`<link rel="alternate" type="application/json+oembed" href="${escAttr(`${SITE}/oembed?url=${encodeURIComponent(pageUrl)}`)}">`);
  return { title: /Spotiky/.test(card.title) ? card.title : `${card.title} · Spotiky`, lines };
}

// Swaps the page's own preview tags (made for the home page) for the card's
function withHead(html, { title, lines }) {
  const end = html.search(/<\/head>/i);
  if (end < 0) return html;
  let top = html.slice(0, end)
    .replace(/[ \t]*<meta\s+(?:property|name)="(?:og:[^"]*|twitter:[^"]*|theme-color|description)"[^>]*>[ \t]*(?:\r?\n)?/gi, "")
    .replace(/[ \t]*<link\b[^>]*application\/json\+oembed[^>]*>[ \t]*(?:\r?\n)?/gi, "");
  const block = lines.map(l => `  ${l}\n`).join("");
  const t = top.match(/<title>[\s\S]*?<\/title>[ \t]*(?:\r?\n)?/i);
  if (t) {
    top = top.slice(0, t.index) + `<title>${escText(title)}</title>\n` + block + top.slice(t.index + t[0].length);
  } else {
    const h = top.match(/<head\b[^>]*>(?:\r?\n)?/i);
    const at = h ? h.index + h[0].length : top.length;
    top = top.slice(0, at) + `  <title>${escText(title)}</title>\n` + block + top.slice(at);
  }
  return top + html.slice(end);
}

const escText = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
const escAttr = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// GET spotiky.com/oembed?url=<a Spotiky page>: Discord reads the artist line and the linked
// site name from here; Slack takes the cover from it too
// A Spotify song link answers too: the page asks for a song's name this way
function spotifyRoute(page) {
  const m = page.hostname === "open.spotify.com" && page.pathname.match(/^\/track\/([a-zA-Z0-9]{22})\/?$/);
  return m ? { kind: "track", id: m[1], start: null, end: null } : null;
}

async function oembedFor(url, env) {
  let page = null;
  try { page = new URL(url.searchParams.get("url") || ""); } catch (err) { /* not an address */ }
  const route = page && (SITE_HOSTS.has(page.hostname) ? pageRoute(page) : spotifyRoute(page));
  const found = route ? await within(previewFor(route, env), BOT_WAIT) : null;
  const card = found === undefined ? fallbackCard(route) : found;
  if (!card || card === GONE) return json({ error: "No preview for that address" }, 404);
  const out = { version: "1.0", type: "link", provider_name: "Spotiky", provider_url: SITE, title: card.title };
  if (card.author) {
    out.author_name = card.author.name;
    if (card.author.url) out.author_url = card.author.url;
  }
  if (card.image && card.image.width && card.image.height) {
    Object.assign(out, { thumbnail_url: card.image.url, thumbnail_width: card.image.width, thumbnail_height: card.image.height });
  }
  return json(out, 200, { "Cache-Control": "public, max-age=3600" });
}

// ---- Helpers -------------------------------------------------------------------------------

function text(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

const isConflict = err => /UNIQUE|constraint/i.test(String(err && err.message));

function base32(bytes) {
  let out = "", n = 0, bits = 0;
  for (const b of bytes) {
    n = (n << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ID_ALPHABET[(n >> bits) & 31];
    }
    n &= (1 << bits) - 1;
  }
  return bits ? out + ID_ALPHABET[(n << (5 - bits)) & 31] : out;
}

// A playlist's fingerprint: SHA-256 of its songs, written with the 32 ID characters
async function fingerprint(s) {
  return base32(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))));
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// HMAC with the PEPPER secret, so stored hashes are useless without it
let hmacKey = null, hmacFor = null;
async function keyed(env, s) {
  if (!env.PEPPER) return sha256hex(s);   // only rate-limit keys get here; accounts require the pepper
  if (hmacFor !== env.PEPPER) {
    hmacKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.PEPPER), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    hmacFor = env.PEPPER;
  }
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(s));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomId(len) {
  return [...crypto.getRandomValues(new Uint8Array(len))].map(b => ID_ALPHABET[b & 31]).join("");
}

function sixDigits() {
  const limit = 4294000000;   // the largest multiple of a million below 2^32, so every code is equally likely
  let n;
  do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= limit);
  return String(n % 1000000).padStart(6, "0");
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
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
