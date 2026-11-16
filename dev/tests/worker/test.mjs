// Code lookups (/codes) and the preview route, with a stand-in D1 database and Spotify
import { newEnv, get, seedCode, T, worker } from './fakes.mjs';
const check = T.check.bind(T);
const ID = '7gaA3wERFkFkgivjwbSvkG';
globalThis.fetch = async (u) => String(u).includes('oembed')
  ? new Response(JSON.stringify({ title: 'Blinding Lights' }), { status: 200 })
  : new Response(`<html><body>https://p.scdn.co/mp3-preview/abc123</body></html>`, { status: 200 });

const env = await newEnv();
seedCode(env, '夜光', 'zh', ID);
seedCode(env, '𓇰𓇶', 'eg', 'A'.repeat(21) + '1');

let [st, body, h] = await get('/codes?c=' + encodeURIComponent('夜光,𓇰𓇶,月光,abc,' + '夜'.repeat(7)), env);
check(st === 200 && body['夜光'].id === ID && body['𓇰𓇶'].type === 'track', `known codes resolve (夜光 -> ${body['夜光'] && body['夜光'].id.slice(0, 6)}…, 𓇰𓇶 -> track)`);
check(body['月光'] === null && body['abc'] === null && body['夜'.repeat(7)] === null, 'unknown, non-code and too-long codes come back null');
check(h.get('access-control-allow-origin') === '*' && h.get('cache-control') === 'no-store', 'CORS set, and a "no song yet" answer isn\'t cached (it can change any minute)');
[st, body, h] = await get('/codes?c=' + encodeURIComponent('夜光,𓇰𓇶'), env);
check(/max-age=300/.test(h.get('cache-control')), 'answers where every code has a song are cached for 5 minutes');
[st, body] = await get('/codes?c=', env);
check(st === 400, 'no codes -> 400');
[st, body] = await get('/codes?c=' + encodeURIComponent(Array.from({ length: 51 }, (_, i) => '码' + i).join(',')), env);
check(st === 400, 'more than 50 codes -> 400');
[st, body] = await get('/codes?c=' + encodeURIComponent('夜光'), {});
check(st === 503 && /set up/.test(body.error), 'no database bound yet -> 503 with a clear message');
[st, body] = await get('/?id=' + ID, {});
check(st === 200 && body.name === 'Blinding Lights' && body.preview_url === 'https://p.scdn.co/mp3-preview/abc123', 'preview route: name + preview MP3');
[st, body] = await get('/?id=bad', {});
check(st === 400, 'preview route still rejects bad ids');
const opt = await worker.fetch(new Request('https://w.dev/codes', { method: 'OPTIONS' }), env);
check(opt.status === 200 && opt.headers.get('access-control-allow-methods') === 'GET, POST, OPTIONS', 'OPTIONS preflight allows GET and POST');
T.done();
