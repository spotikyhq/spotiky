// spotiky.com in front of GitHub Pages: song, code and playlist pages come back with status 200
// and their own preview tags, for Discord and the rest. A stand-in GitHub Pages answers like the
// real one: index.html for /, and 404.html (the same page) with status 404 for every other page.
import { readFileSync } from 'node:fs';
import { newEnv, seedCode, T, worker, ID1, ID2, ID3, SONGS, PAGES, spotify } from './fakes.mjs';
const check = T.check.bind(T);

const PAGE = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8');
const ID4 = 'D'.repeat(21) + '4', ID5 = 'E'.repeat(21) + '5', ID6 = 'F'.repeat(21) + '6', ID7 = 'G'.repeat(21) + '7', ID8 = 'H'.repeat(21) + '8';
SONGS[ID4] = ['Wildest Dreams', 'Taylor Swift'];
SONGS[ID5] = ['Slow Song', 'Slowpoke'];
SONGS[ID6] = ['Slower Song', 'Slowpoke'];
SONGS[ID8] = [`Don't "Stop" <Now> & Then`, 'A & B'];
const ARTIST = 'W'.repeat(22);
const COVER = 'https://image-cdn-fa.spotifycdn.com/image/ab67616d0000b273aaa';

// The embed page as Spotify sends it now: its data carries the artists, the covers and a color
const nextData = (title, artist, color, isFallback) => JSON.stringify({ props: { pageProps: { state: { data: { entity: {
  type: 'track', name: title, title, uri: 'spotify:track:x',
  artists: [{ name: artist, uri: `spotify:artist:${ARTIST}` }],
  coverArt: {
    extractedColors: { colorDark: { hex: color, isFallback } },
    sources: [
      { url: 'https://image-cdn-ak.spotifycdn.com/image/ab67616d00001e02aaa', width: 300, height: 300 },
      { url: 'https://image-cdn-ak.spotifycdn.com/image/ab67616d00004851aaa', width: 64, height: 64 },
      { url: COVER, width: 640, height: 640 },
    ],
  },
  duration: 200040, audioPreview: { url: 'https://p.scdn.co/mp3-preview/abc' },
} } } } } });
PAGES[ID1] = `<!DOCTYPE html><html><head></head><body><script id="__NEXT_DATA__" type="application/json">${nextData('Blinding Lights', 'The Weeknd', '#7E3B2C', false)}</script></body></html>`;
PAGES[ID4] = `<!DOCTYPE html><html><head></head><body><script id="__NEXT_DATA__" type="application/json">${nextData('Wildest Dreams', 'Taylor Swift', '#535353', true)}</script></body></html>`;

// GitHub Pages, and Spotify with a delay for some songs
const spotifyFetch = globalThis.fetch;
const origin = [], spotifyCalls = [], slow = new Map();
const pageHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'max-age=600', ETag: '"6740f1a2"' };
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith('https://spotiky.com/')) {
    origin.push({ url, method: input instanceof Request ? input.method : 'GET' });
    const path = new URL(url).pathname;
    if (path === '/' || path === '/index.html') return new Response(PAGE, { status: 200, headers: pageHeaders });
    if (path === '/collection.js') return new Response('/* collection */', { status: 200, headers: { 'Content-Type': 'application/javascript' } });
    return new Response(PAGE, { status: 404, headers: pageHeaders });   // 404.html
  }
  spotifyCalls.push(url);
  for (const [id, ms] of slow) if (url.includes(id)) await new Promise(r => setTimeout(r, ms));
  return spotifyFetch(input, init);
};

const DISCORD = 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)';
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const makeCtx = () => { const c = { waits: [], passed: 0, waitUntil(p) { c.waits.push(p); }, passThroughOnException() { c.passed++; } }; return c; };
const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function metaOf(html) {
  const head = html.split(/<\/head>/i)[0] || '';
  const out = { _head: head };
  for (const m of head.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) (out[m[1]] ||= []).push(unesc(m[2]));
  const titles = [...head.matchAll(/<title>([^<]*)<\/title>/g)];
  out.title = titles.length === 1 ? unesc(titles[0][1]) : `${titles.length} titles`;
  const o = head.match(/<link rel="alternate" type="application\/json\+oembed" href="([^"]+)">/);
  out.oembed = o && unesc(o[1]);
  return out;
}
const tag = (r, k) => (r.meta[k] ? (r.meta[k].length === 1 ? r.meta[k][0] : `${r.meta[k].length} copies`) : undefined);

async function open(path, { ua = DISCORD, method = 'GET', host = 'spotiky.com', env: e, ctx } = {}) {
  const t0 = Date.now();
  const r = await worker.fetch(new Request(`https://${host}${path}`, { method, headers: { 'User-Agent': ua } }), e || env, ctx);
  const text = method === 'HEAD' ? '' : await r.text();
  return { status: r.status, text, headers: r.headers, meta: metaOf(text), ms: Date.now() - t0, body: method === 'HEAD' ? null : text };
}
async function oembed(link) {
  const r = await worker.fetch(new Request(link, { headers: { 'User-Agent': DISCORD } }), env);
  return [r.status, await r.json()];
}
const lightness = hex => { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => v / 255); return (Math.max(...c) + Math.min(...c)) / 2; };
const bodyOf = html => html.slice(html.search(/<\/head>/i));

const env = await newEnv();
seedCode(env, '夜光', 'zh', ID1);
seedCode(env, '🌃💡', 'em', ID1);
seedCode(env, '𓇰𓇶', 'eg', ID1);
seedCode(env, '星光', 'zh', ID2);
seedCode(env, '👋🌙', 'em', ID2);
const now = '2026-11-17T00:00:00.000Z';
const addList = (id, items, labels, owner = 'o1') => env.DB.sql.prepare('INSERT INTO playlists (id, items, hash, owner, labels, why, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  .run(id, items, 'h-' + id, owner, JSON.stringify(labels), '', now, now);
const LABELS = { zh: { code: '夜歌' }, eg: { code: '𓇰𓇼' }, em: { code: '🌙🎧' }, en: { code: 'night-drive' }, _typed: ['en'] };
addList('5mh', `${ID1}$83-105,星光,${ID3}`, LABELS);
addList('7kq', `${ID1},${ID2},${ID3},${ID4},${ID1}$10-20`, { zh: { code: '五首' }, em: { code: '🎵🎶' } });
addList('9xz', `${ID1}`, { zh: { code: '没了' } });
env.DB.sql.prepare('INSERT INTO shelf (id, owner, deleted) VALUES (?, ?, ?)').run('9xz', 'o1', now);

// ---- A song link, as Discord fetches it ----
let ctx = makeCtx();
let r = await open(`/track/${ID1}$13-44`, { ctx });
check(r.status === 200 && /^text\/html/.test(r.headers.get('content-type')), `a song link comes back with status 200, not GitHub Pages' 404 (${r.status})`);
check(tag(r, 'og:title') === 'Blinding Lights' && r.meta.title === 'Blinding Lights · Spotiky', `title: the song's name (${tag(r, 'og:title')} / ${r.meta.title})`);
check(tag(r, 'og:description') === 'Clip 0:13–0:44 · 夜光 · 🌃💡', `description: the clip's times, then the song's Chinese and emoji codes (${tag(r, 'og:description')})`);
check(tag(r, 'og:image') === COVER && tag(r, 'og:image:width') === '640' && tag(r, 'og:image:height') === '640', `the 640px cover from the embed page (${tag(r, 'og:image')})`);
check(tag(r, 'twitter:card') === 'summary_large_image' && tag(r, 'og:type') === 'music.song' && tag(r, 'og:site_name') === 'Spotiky', 'large cover layout, music.song, site name Spotiky');
check(tag(r, 'og:url') === `https://spotiky.com/track/${ID1}$13-44`, `og:url is the link itself (${tag(r, 'og:url')})`);
const stripe = tag(r, 'theme-color');
check(/^#[0-9a-f]{6}$/.test(stripe) && stripe !== '#1db954' && lightness(stripe) >= 0.49, `the stripe takes the cover's color, made light enough to see (${stripe}, from #7E3B2C)`);
r = await open(`/track/${ID4}`);
check(tag(r, 'theme-color') === '#1DB954', `Spotify's grey stand-in color is skipped for Spotiky green (${tag(r, 'theme-color')})`);
r = await open(`/track/${ID1}$13-44`);
check(!r.text.includes('Play Spotify at Timestamp') && !r.text.includes('og.png') && !r.text.includes('#1DB954"'), "the home page's own preview tags are gone, so nothing competes with the song's");
check(r.meta._head.includes('<meta charset="UTF-8">') && r.meta._head.includes('name="viewport"'), 'charset and viewport stay');
check(bodyOf(r.text) === bodyOf(PAGE), 'everything after </head> is exactly the page GitHub Pages sent');
check(r.headers.get('etag') === null && r.headers.get('cache-control') === 'max-age=600', "GitHub's ETag is dropped (the page changed), its Cache-Control kept");
check(ctx.passed === 1 && ctx.waits.length === 1, 'passThroughOnException is on, and the lookup is handed to waitUntil');

let [st, oe] = await oembed(r.meta.oembed);
check(st === 200 && oe.version === '1.0' && oe.type === 'link' && oe.provider_name === 'Spotiky' && oe.provider_url === 'https://spotiky.com', 'oEmbed: Spotiky as the linked site name');
check(oe.author_name === 'The Weeknd' && oe.author_url === `https://open.spotify.com/artist/${ARTIST}`, `oEmbed: the artist line, linked to Spotify (${oe.author_name}, ${oe.author_url})`);
check(oe.thumbnail_url === COVER && oe.thumbnail_width === 640 && oe.title === 'Blinding Lights', 'oEmbed: title and cover, for apps that read only oEmbed');
check(spotifyCalls.filter(u => u.includes(ID1)).length === 2, `the page and its oEmbed asked Spotify once between them (${spotifyCalls.filter(u => u.includes(ID1)).length} fetches: oEmbed + embed page)`);

// ---- Times, as the page reads them ----
for (const [path, want] of [
  [`/track/${ID1}`, 'Full song'], [`/track/${ID1}$83`, 'Starts at 1:23'], [`/track/${ID1}$1:23-1:45`, 'Clip 1:23–1:45'],
  [`/track/${ID1}?si=abc&t=1:23`, 'Starts at 1:23'], [`/track/${ID1}.83`, 'Starts at 1:23'], [`/track/${ID1}$1.23`, 'Starts at 1:23'],
  [`/track/${ID1}$83-80`, 'Starts at 1:23'], [`/track/${ID1}$1:02:03`, 'Starts at 1:02:03'], [`/track/${ID1}%2483-105`, 'Clip 1:23–1:45'],
]) {
  r = await open(path);
  const d = (tag(r, 'og:description') || '').split(' · ')[0];
  check(r.status === 200 && d === want, `${path.replace(ID1, 'ID')} -> "${d}"`);
}

// ---- Code links ----
r = await open('/夜光83-105');
check(r.status === 200 && tag(r, 'og:title') === 'Blinding Lights' && tag(r, 'og:description') === 'Clip 1:23–1:45 · 夜光 · 🌃💡', `/夜光83-105 -> ${tag(r, 'og:title')}, "${tag(r, 'og:description')}"`);
check(tag(r, 'og:url') === 'https://spotiky.com/%E5%A4%9C%E5%85%8983-105', `og:url stays ASCII (${tag(r, 'og:url')})`);
r = await open('/track/夜光1:23-1:45');
check(r.status === 200 && tag(r, 'og:description') === 'Clip 1:23–1:45 · 夜光 · 🌃💡', '/track/夜光1:23-1:45 works the same');
r = await open('/𓇰𓇶3.23-3.24');
check(tag(r, 'og:description') === 'Clip 3:23–3:24 · 𓇰𓇶 · 夜光 · 🌃💡', `a hieroglyph link shows its own code first (${tag(r, 'og:description')})`);
r = await open('/👋🏾🌙83');
check(r.status === 200 && tag(r, 'og:title') === 'Ocean Eyes' && tag(r, 'og:description') === 'Starts at 1:23 · 👋🏾🌙 · 星光', `a skin tone stays as the sharer picked it, and the toneless twin isn't repeated (${tag(r, 'og:description')})`);
check(tag(r, 'og:image') === 'https://i.scdn.co/x' && tag(r, 'og:image:width') === undefined, "without the embed page's data, the cover comes from oEmbed, with no made-up size");
r = await open('/月城');
check(r.status === 404 && r.text === PAGE, 'a code no song has yet keeps its 404 and the page untouched (the page says so itself)');

// ---- Playlists ----
r = await open('/playlist/5mh夜歌');
check(r.status === 200 && tag(r, 'og:title') === '夜歌' && tag(r, 'og:type') === 'music.playlist', `/playlist/5mh夜歌 -> "${tag(r, 'og:title')}"`);
check(tag(r, 'og:description') === 'Blinding Lights · Ocean Eyes · Dreams', `its first songs by name, codes looked up (${tag(r, 'og:description')})`);
check(tag(r, 'og:image') === COVER, 'the first cover in the list');
check(/^#[0-9a-f]{6}$/.test(tag(r, 'theme-color')) && lightness(tag(r, 'theme-color')) >= 0.49, `the stripe is its sleeve's color (${tag(r, 'theme-color')})`);
[st, oe] = await oembed(r.meta.oembed);
check(st === 200 && oe.author_name === 'Playlist · 3 songs' && !oe.author_url, `oEmbed author line: ${oe.author_name}`);
r = await open('/playlist/5mh-night-drive');
check(tag(r, 'og:title') === '“night-drive”', `a name its owner typed keeps its quotes, like on the site (${tag(r, 'og:title')})`);
r = await open('/playlist/5mh');
check(tag(r, 'og:title') === '“night-drive”', 'no label in the link: the typed name');
r = await open('/playlist/5mh🌙🎧');
check(tag(r, 'og:title') === '🌙🎧', 'an emoji link shows the emoji name');
r = await open('/playlist/5mh旧名');
check(tag(r, 'og:title') === '夜歌', 'an old link from before a rename shows the current name of its kind');
r = await open('/playlist/7kq');
check(tag(r, 'og:title') === '🎵🎶' && tag(r, 'og:description') === 'Blinding Lights · Ocean Eyes · Dreams + 2 more', `5 songs: three named, "+ 2 more" (${tag(r, 'og:description')})`);
r = await open('/playlist/9xz没了');
check(r.status === 410 && r.text === PAGE, 'a deleted playlist: 410, the page says so itself');
r = await open('/playlist/8vv夜歌');
check(r.status === 404 && r.text === PAGE, 'no playlist has that ID: the 404 stays');
r = await open(`/playlist/${ID1}$83,${ID2}`);
check(r.status === 200 && tag(r, 'og:title') === 'A Spotiky playlist' && tag(r, 'og:description') === 'Blinding Lights · Ocean Eyes', `a long link with the songs in it (${tag(r, 'og:description')})`);
[st, oe] = await oembed(r.meta.oembed);
check(oe.author_name === 'Playlist · 2 songs', 'its oEmbed counts its songs');
r = await open('/playlist');
check(r.status === 200 && tag(r, 'og:title') === 'Make a playlist on Spotiky' && tag(r, 'twitter:card') === 'summary' && !tag(r, 'og:image') && r.meta.title === 'Make a playlist on Spotiky', 'the blank playlist maker');
r = await open('/account');
check(r.status === 200 && tag(r, 'og:title') === 'Your Spotiky collection', 'the account page');
r = await open('/playlist/37i9dQZF1DXcBWIGoYBM5M');
check(r.status === 404 && r.text === PAGE, "a Spotify playlist's own ID passes through untouched");

// ---- The oldest links ----
r = await open(`/?track=${ID3}&t=83`);
check(r.status === 200 && tag(r, 'og:title') === 'Dreams' && tag(r, 'og:description') === 'Starts at 1:23', `/?track=ID&t=83 (${tag(r, 'og:title')}, ${tag(r, 'og:description')})`);

// ---- Everything else passes straight through ----
const before = spotifyCalls.length;
r = await open('/');
check(r.status === 200 && r.text === PAGE, 'the home page is untouched');
r = await open('/collection.js');
check(r.status === 200 && r.text === '/* collection */', 'collection.js is untouched');
r = await open('/favicon.ico');
check(r.status === 404 && r.text === PAGE, 'a missing file keeps its 404');
r = await open('/resume/');
check(r.status === 404 && r.text === PAGE, "the resume folder's addresses pass through");
r = await open(`/track/${ID1}$13-44`, { method: 'POST' });
check(r.status === 404 && r.text === PAGE, 'a POST passes through');
check(spotifyCalls.length === before, 'none of those asked Spotify anything');

// ---- HEAD, and the other names ----
r = await open(`/track/${ID1}$13-44`, { method: 'HEAD' });
check(r.status === 200 && /^text\/html/.test(r.headers.get('content-type')), 'HEAD: 200, as HTML');
const redirect = await worker.fetch(new Request(`https://open.spotiky.com/track/${ID1}$13-44?si=abc`), env);
check(redirect.status === 301 && redirect.headers.get('location') === `https://spotiky.com/track/${ID1}$13-44?si=abc`, `open.spotiky.com sends to spotiky.com, path and query kept (${redirect.headers.get('location')})`);

// ---- A person opening the page doesn't wait for Spotify; preview fetchers do ----
slow.set(ID5, 1500);
ctx = makeCtx();
r = await open(`/track/${ID5}$13-44`, { ua: CHROME, ctx });
check(r.status === 200 && r.ms < 1300 && tag(r, 'og:title') === 'Play this song on Spotiky' && tag(r, 'og:description') === 'Clip 0:13–0:44', `a browser gets the page in ${r.ms} ms, with a card that needs no song details`);
await Promise.all(ctx.waits);
r = await open(`/track/${ID5}$13-44`, { ua: CHROME });
check(tag(r, 'og:title') === 'Slow Song' && r.ms < 300, `the lookup finished in the background: the next visit has the song (${tag(r, 'og:title')}, ${r.ms} ms)`);
slow.set(ID6, 1500);
r = await open(`/track/${ID6}$13-44`);
check(r.ms >= 1400 && tag(r, 'og:title') === 'Slower Song', `Discord waits for the song (${r.ms} ms)`);

// ---- When Spotify can't say, or the database fails ----
spotify.oembedDown = true;
r = await open(`/track/${ID7}$5`);
check(r.status === 200 && tag(r, 'og:title') === 'Play this song on Spotiky' && tag(r, 'og:description') === 'Starts at 0:05' && !tag(r, 'og:image') && tag(r, 'twitter:card') === 'summary', 'Spotify down: still a preview, with the times');
spotify.oembedDown = false;
const broken = { DB: { prepare() { throw new Error('D1 is down'); } } };
ctx = makeCtx();
r = await open('/夜光83', { env: broken, ctx });
check(r.status === 200 && tag(r, 'og:title') === 'Play this song on Spotiky' && tag(r, 'og:description') === 'Starts at 1:23 · 夜光' && bodyOf(r.text) === bodyOf(PAGE), 'database down: the page still loads, with a card from the link alone');
r = await open('/playlist/5mh夜歌', { env: broken });
check(r.status === 200 && tag(r, 'og:title') === 'A Spotiky playlist', 'the same for a playlist');

// ---- Escaping ----
r = await open(`/track/${ID8}`);
check(tag(r, 'og:title') === `Don't "Stop" <Now> & Then` && !r.meta._head.includes('<Now>') && r.meta._head.includes('content="Don&#39;t &quot;Stop&quot; &lt;Now&gt; &amp; Then"'), 'a title with quotes, < and & is escaped in the tags');
check(r.meta.title === `Don't "Stop" <Now> & Then · Spotiky` && r.meta._head.includes('<title>Don\'t "Stop" &lt;Now&gt; &amp; Then · Spotiky</title>'), 'and in <title>');
[st, oe] = await oembed(r.meta.oembed);
check(oe.author_name === 'A & B', 'the oEmbed answer is JSON, so it needs no escaping');

// ---- oEmbed only answers for Spotiky pages ----
[st, oe] = await oembed('https://spotiky.com/oembed?url=' + encodeURIComponent('https://example.com/track/' + ID1));
check(st === 404, 'oEmbed for another site: 404');
[st, oe] = await oembed('https://spotiky.com/oembed?url=' + encodeURIComponent('https://spotiky.com/playlist/9xz'));
check(st === 404, 'oEmbed for a deleted playlist: 404');
[st, oe] = await oembed('https://spotiky.com/oembed');
check(st === 404, 'oEmbed with no address: 404');

// ---- The Worker's own address is unchanged ----
const api = await worker.fetch(new Request('https://spotiky-preview.spotikyhq.workers.dev/codes?c=' + encodeURIComponent('夜光')), env);
check(api.status === 200 && (await api.json())['夜光'].id === ID1, 'the API on workers.dev answers as before');
T.done();
