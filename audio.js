// Spotiky audio: a song's clip as an MP3, for Discord's player (an embed can't play anything,
// an uploaded file can). The whole file comes from Deezer's CDN and the clip is cut out of it
// on MP3 frame boundaries, so any timestamp works and nothing is ever re-encoded.
// Imported by preview-worker.js; self-contained on purpose, so the Worker changes stay tiny.
//
// GET /audio/ID.mp3[?s=83&e=105&n=Name]  ->  audio/mpeg, 206 for a byte range
// Needs KV (cached lookups), DEEZER_ARL, SPOTIFY_ID and SPOTIFY_SECRET.

const SITE = "https://spotiky.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const DEEZER_GW = "https://www.deezer.com/ajax/gw-light.php";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "X-Spotiky-Source, Content-Length",
};

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json", ...headers } });

export async function audio(request, env, ctx, url) {
  const m = url.pathname.match(/^\/audio\/([a-zA-Z0-9]{22})(?:\.mp3)?$/);
  if (!m) return json({ error: "Not an audio link" }, 404);
  const id = m[1];
  const head = request.method === "HEAD";

  let s = Math.max(0, Math.floor(Number(url.searchParams.get("s")) || 0));
  let e = Math.max(0, Math.floor(Number(url.searchParams.get("e")) || 0));
  if (e && e <= s) e = 0;
  const clip = !!(s || e);
  const clipKey = clip ? `${id}:${s}:${e}` : null;

  // A clip never changes, so it's kept and served straight from R2 next time
  if (clipKey && env.R2) {
    const kept = await env.R2.get(clipKey);
    if (kept) return send(kept.body, null, url, "r2", head);
  }

  const got = await audioBytes(id, env, ctx);
  if (!got) return json({ error: "This song has no audio" }, 404, { "X-Spotiky-Source": "none" });

  const body = clip ? sliceMp3(got.bytes, s, e) : null;
  if (clipKey && env.R2 && body && body.byteLength) ctx.waitUntil(env.R2.put(clipKey, body.slice()));
  return send(body || got.bytes, body ? got.source : got.source + "-whole", url, null, head);
}

function send(bytes, source, url, forced, head) {
  const headers = {
    ...CORS,
    "Content-Type": "audio/mpeg",
    "Content-Length": String(bytes.byteLength),
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=604800",
    "Content-Disposition": `inline; filename="${asciiName(url.searchParams.get("n"))}.mp3"`,
    "X-Spotiky-Source": forced || source || "unknown",
  };
  return new Response(head ? null : bytes, { status: 200, headers });
}

const asciiName = v =>
  String(v || "").replace(/[\\"\r\n\t/]+/g, " ").replace(/[^\x20-\x7E]/g, "").replace(/\s+/g, " ").trim().slice(0, 90) || "spotiky";

// ---- Audio ---------------------------------------------------------------------------------

// The whole file when Deezer has it, else Spotify's 30-second preview from a different CDN
async function audioBytes(id, env, ctx) {
  const full = await deezerFull(id, env).catch(() => null);
  if (full) {
    const res = await fetch(full.url, { headers: { "User-Agent": UA } }).catch(() => null);
    if (res && res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > 20000) return { bytes, source: "deezer" };
    } else if (res && (res.status === 403 || res.status === 404)) {
      ctx.waitUntil(env.KV.delete(`full:${id}`));   // the CDN address went stale
    }
  }
  const prev = await previewBytes(id, env, ctx);
  return prev ? { bytes: prev, source: "preview" } : null;
}

// A track's whole file on Deezer's CDN: { url, dzId }, or null. Resolved once, then cached.
async function deezerFull(id, env) {
  if (!env.KV || !env.DEEZER_ARL) return null;
  const kept = await env.KV.get(`full:${id}`, "json");
  if (kept && kept.url) return kept;
  const isrc = await isrcFor(id, env);
  if (!isrc) return null;
  const dzId = await deezerIdFor(isrc);
  if (!dzId) return null;
  const url = await deezerStream(dzId, env);
  if (!url) return null;
  const out = { url, dzId };
  await env.KV.put(`full:${id}`, JSON.stringify(out), { expirationTtl: 604800 });
  return out;
}

// An app token from Spotify, for ISRCs only
async function spotifyToken(env) {
  if (!env.SPOTIFY_ID || !env.SPOTIFY_SECRET) return null;
  const kept = await env.KV.get("spotify-token");
  if (kept) return kept;
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.SPOTIFY_ID}:${env.SPOTIFY_SECRET}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || !data.access_token) return null;
  await env.KV.put("spotify-token", data.access_token, { expirationTtl: Math.max(60, (data.expires_in || 3600) - 60) });
  return data.access_token;
}

// The song's ISRC, the one ID Spotify and Deezer both know it by
async function isrcFor(id, env) {
  const kept = await env.KV.get(`isrc:${id}`);
  if (kept) return kept;
  const token = await spotifyToken(env);
  if (!token) return null;
  const res = await fetch(`https://api.spotify.com/v1/tracks/${id}?market=US`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const isrc = ((await res.json().catch(() => ({}))).external_ids || {}).isrc || null;
  if (isrc) await env.KV.put(`isrc:${id}`, isrc);
  return isrc;
}

async function deezerIdFor(isrc) {
  const res = await fetch(`https://api.deezer.com/track/isrc:${encodeURIComponent(isrc)}`).catch(() => null);
  const data = res && res.ok ? await res.json().catch(() => null) : null;
  return data && data.id ? String(data.id) : null;
}

// The CDN address for a Deezer track. One account; when it answers badly it cools for five
// minutes so requests stop hammering it.
async function deezerStream(dzId, env) {
  const cookie = env.DEEZER_ARL;
  const coolKey = "arlcool";
  if (await env.KV.get(coolKey)) return null;
  const cool = () => env.KV.put(coolKey, "1", { expirationTtl: 300 });
  try {
    const gw = await fetch(`${DEEZER_GW}?method=deezer.getUserData&input=3&api_version=1.0&api_token=`, {
      headers: { Cookie: `arl=${cookie}`, "User-Agent": UA },
    });
    const token = gw.ok ? ((await gw.json().catch(() => ({}))).results || {}).checkForm : null;
    if (!token) { await cool(); return null; }
    const list = await fetch(`${DEEZER_GW}?method=song.getListData&input=3&api_version=1.0&api_token=${token}`, {
      method: "POST",
      headers: { Cookie: `arl=${cookie}`, "Content-Type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ sng_ids: [dzId] }),
    });
    const song = list.ok ? ((((await list.json().catch(() => ({}))).results || {}).data) || [])[0] : null;
    if (!song || !song.MD5_ORIGIN) return null;
    const cdn = (parseInt(song.MD5_ORIGIN.slice(-1), 16) % 4) + 1;   // which CDN holds the file
    return `https://e-cdns-progressive-${cdn}.dzcdn.net/mobile/1/${song.MD5_ORIGIN}/${song.MEDIA_VERSION}/${dzId}`;
  } catch (err) {
    return null;
  }
}

// Spotify's 30-second preview bytes, for songs Deezer doesn't carry. Kept a week.
async function previewBytes(id, env, ctx) {
  const cache = typeof caches !== "undefined" && caches.default;
  const key = `${SITE}/.audio/${id}`;
  const kept = cache && (await cache.match(key).catch(() => null));
  if (kept) return new Uint8Array(await kept.arrayBuffer());
  const res = await fetch(`https://open.spotify.com/embed/track/${id}`, { headers: { "User-Agent": UA } }).catch(() => null);
  if (!res || !res.ok) return null;
  const html = await res.text();
  const found = previewUrlIn(html);
  if (!found) return null;
  const file = await fetch(found, { headers: { "User-Agent": UA } }).catch(() => null);
  if (!file || !file.ok) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength < 2000 || bytes.byteLength > 8e6) return null;
  if (cache) {
    ctx.waitUntil(cache.put(key, new Response(bytes, {
      headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=604800" },
    })).catch(() => {}));
  }
  return bytes;
}

// The preview MP3's address on an embed page
function previewUrlIn(html) {
  const plain = html.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[a-zA-Z0-9]+/);
  if (plain) return plain[0];
  const data = html.match(/"audioPreview":\s*{\s*"url":\s*"([^"]+)"/);
  return data ? data[1].replace(/\\\//g, "/") : null;
}

// ---- Cutting the clip ----------------------------------------------------------------------
// MP3 has no container: the frames are the timeline. Walk the headers, take the byte range
// between two times. Frame-accurate to about 26ms, and lossless because nothing is decoded.

const MP3_BITRATE = [[0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
                     [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]];
const MP3_RATE = [[44100, 48000, 32000], [22050, 24000, 16000], [11025, 12000, 8000]];

function mp3Frame(b, at) {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[at + 1] >> 3) & 3;          // 3 MPEG1, 2 MPEG2, 0 MPEG2.5
  const layer = (b[at + 1] >> 1) & 3;            // 1 is layer III
  if (version === 1 || layer === 0) return null;
  const bitrate = MP3_BITRATE[version === 3 ? 0 : 1][(b[at + 2] >> 4) & 15];
  const rate = MP3_RATE[version === 3 ? 0 : version === 2 ? 1 : 2][(b[at + 2] >> 2) & 3];
  if (!bitrate || !rate) return null;
  const length = Math.floor((version === 3 ? 144000 : 72000) * bitrate / rate) + ((b[at + 2] >> 1) & 1);
  return { length, samples: version === 3 ? 1152 : 576, rate };
}

// The clip as bytes, or null when the times fall outside the file (the caller sends all of it)
function sliceMp3(b, start, end) {
  let at = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {   // ID3v2 tag
    at = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
  }
  while (at + 4 < b.length && !mp3Frame(b, at)) at++;      // to the first frame
  let t = 0, from = -1, to = -1;
  while (at + 4 <= b.length) {
    const f = mp3Frame(b, at);
    if (!f) { at++; continue; }
    if (from < 0 && t >= start) from = at;
    t += f.samples / f.rate;
    if (from >= 0 && end > 0 && t >= end) { to = at + f.length; break; }
    at += f.length;
  }
  if (from < 0) return null;
  if (to < 0 || to > b.length) to = b.length;
  return to > from ? b.subarray(from, to) : null;
}
