// Stand-ins shared by the Worker tests: Spotify, the word list, Resend, the AI and a D1 database.
import worker from './worker.mjs';
import { makeDB } from './d1.mjs';

export const ID1 = 'A'.repeat(21) + '1', ID2 = 'B'.repeat(21) + '2', ID3 = 'C'.repeat(21) + '3';
export const SONGS = { [ID1]: ['Blinding Lights', 'The Weeknd'], [ID2]: ['Ocean Eyes', 'Billie Eilish'], [ID3]: ['Dreams', 'Fleetwood Mac'] };
export const PAGES = {};                       // embed pages that differ from the usual one
export const spotify = { oembedDown: false };
export const resend = { down: false, sent: [] };

// Spotify as it is now: oEmbed gives the title; the embed page has no <title> but shows the title and an artist link
const embedHtml = (title, artist) => '<!DOCTYPE html><html lang="en"><head><meta name="viewport" content="width=device-width"></head><body>'
  + `<img alt="${title} cover" src="https://i.scdn.co/image/x"><h1 class="t"><a href="https://open.spotify.com/track/x" target="_blank">${title}</a></h1>`
  + `<h2><a href="https://open.spotify.com/artist/${'Z'.repeat(22)}?utm_source=embed" target="_blank">${artist}</a></h2>`
  + '<script>window.x={"audioPreview":{"url":"https://p.scdn.co/mp3-preview/abc"}}</script></body></html>';

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url === 'https://api.resend.com/emails') {
    if (resend.down) return new Response('{"message":"down"}', { status: 500 });
    resend.sent.push({ auth: init.headers.Authorization, ...JSON.parse(init.body) });
    return new Response('{"id":"e1"}', { status: 200 });
  }
  if (url.includes('zh-words.json')) return new Response(JSON.stringify({ '星光': 'starlight', '开心': 'to feel happy', '夜歌': 'night song' }), { status: 200 });
  const oe = url.match(/\/oembed\?url=([^&]+)/);
  if (oe) {
    const id = decodeURIComponent(oe[1]).split('/').pop();
    if (spotify.oembedDown || !SONGS[id]) return new Response('{"error":"Not found"}', { status: 404 });
    return new Response(JSON.stringify({ type: 'rich', version: '1.0', provider_name: 'Spotify', title: SONGS[id][0], thumbnail_url: 'https://i.scdn.co/x' }), { status: 200 });
  }
  const id = url.split('/').pop();
  if (PAGES[id]) return new Response(PAGES[id], { status: 200 });
  if (SONGS[id]) return new Response(embedHtml(...SONGS[id]), { status: 200 });
  return new Response('nope', { status: 404 });
};

export const goodAnswer = {
  zh: [
    { code: '夜光', chars: [{ char: '夜', meaning: 'night' }, { char: '光', meaning: 'light' }], word: null, why: 'Neon city nights, chasing someone' },
    { code: '星光', chars: [{ char: '星', meaning: 'star' }, { char: '光', meaning: 'light' }], word: null, why: 'Bright lights in the dark' },
    { code: '傻逼', chars: [], word: null, why: 'blocked' },
    { code: '龘靐', chars: [], word: null, why: 'rare characters' },
  ],
  zh_alts: [[{ char: '月', meaning: 'moon' }, { char: '城', meaning: 'city' }, { char: '龘', meaning: 'rare' }], [{ char: '火', meaning: 'fire' }, { char: '灯', meaning: 'lamp' }]],
  eg: [{ code: '𓇰𓇶', why: 'Night and light' }, { code: '𓀀𓇶', why: 'uses a sign outside the set' }, { code: '𓇼𓊮', why: 'Star and fire' }],
  eg_alts: [['𓇹', '𓇼', '𓀀'], ['𓊮', '𓇳']],
  em: [{ code: '🌃💡', why: 'City lights after dark' }, { code: '🫶🌃', why: 'a newer emoji (Emoji 14)' }, { code: '🍆💦', why: 'left out of the set' }, { code: '🌙🚗', why: 'A night drive' }],
  em_alts: [['🌙', '🫶', '🌃'], ['🔦', '🚗']],
  en: [{ code: 'fuck-yeah', why: 'blocked' }, { code: 'Night Drive', why: 'Late drives under city lights' }, { code: 'three word label', why: 'too long' }, { code: 'neon', why: 'One bright word' }],
  en_alts: [['late', 'city', 'shit', 'X'], ['ride', 'glow']],
};

export function fakeAI(answers) {
  const calls = [];
  return {
    calls,
    async run(model, input) {
      calls.push({ model, input });
      const a = answers[Math.min(calls.length - 1, answers.length - 1)];
      return typeof a === 'string' ? { response: a } : { choices: [{ message: { content: '<think>hmm</think>```json\n' + JSON.stringify(a) + '\n```' } }] };
    },
  };
}

// A fresh Worker setup with its own empty database (tables made by a first request)
export async function newEnv(extra = {}) {
  const env = { DB: makeDB(), ...extra };
  await worker.fetch(new Request('https://w.dev/codes?c=' + encodeURIComponent('夜光')), env);   // the first request makes the tables
  return env;
}

export async function call(method, path, body, env, { token, ip } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (ip) headers['CF-Connecting-IP'] = ip;
  const r = await worker.fetch(new Request('https://w.dev' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  return [r.status, await r.json(), r.headers];
}
export const post = (path, body, env, opts) => call('POST', path, body, env, opts);
export const get = (path, env, opts) => call('GET', path, undefined, env, opts);
export const one = (env, sql, ...args) => env.DB.sql.prepare(sql).get(...args);
export const all = (env, sql, ...args) => env.DB.sql.prepare(sql).all(...args);
export const seedCode = (env, code, script, track) =>
  env.DB.sql.prepare("INSERT INTO song_codes (code, script, track, created) VALUES (?, ?, ?, '2026-01-01')").run(code, script, track);

export const T = {
  pass: 0, fail: 0,
  check(ok, msg) { ok ? this.pass++ : this.fail++; console.log((ok ? 'ok   ' : 'FAIL ') + msg); },
  done() { console.log(`\n${this.pass} passed, ${this.fail} failed`); },
};
export { worker };
