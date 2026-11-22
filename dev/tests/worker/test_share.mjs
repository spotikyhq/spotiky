// Song codes in the Worker: /suggest and /claim with a stand-in AI, Spotify and D1 database.
import { ID1, ID2, ID3, SONGS, PAGES, spotify, goodAnswer, fakeAI, newEnv, post, get, one, all, seedCode, T, worker } from './fakes.mjs';
const check = T.check.bind(T);
const TONE = /[\u{1F3FB}-\u{1F3FF}]/u;

// 1. A new song gets suggestions
{
  const env = await newEnv({ AI: fakeAI([goodAnswer]) });
  const [st, b] = await post('/suggest', { type: 'track', id: ID1 }, env);
  check(st === 200 && !b.existing && b.zh.code === '夜光' && b.eg.code === '𓇰𓇶', `new song -> zh ${b.zh && b.zh.code}, glyphs ${b.eg && b.eg.code}`);
  check(b.zh.chars.map(c => c.meaning).join('/') === 'night/light' && b.eg.chars.map(c => c.name).join('/') === 'night/sunshine', 'each character comes with its meaning (glyph meanings from the Spotiky set)');
  check(b.zh.options[0].map(o => o.char).join('') === '夜月城星' && b.zh.options[1].map(o => o.char).join('') === '光火灯', `dropdown choices: ${b.zh.options.map(p => p.map(o => o.char).join('')).join(' | ')} (rare 龘 dropped)`);
  check(b.eg.options[0].map(o => o.char).join('') === '𓇰𓇹𓇼' && b.eg.options[1].map(o => o.char).join('') === '𓇶𓊮𓇳', 'glyph choices keep only signs from the set');
  check(b.about[0] === '"Blinding Lights" by The Weeknd', `song read from Spotify: ${b.about[0]}`);
  check(b.em.code === '🌃💡' && b.em.chars.map(c => c.name).join('/') === 'night with stars/light bulb' && b.em.saved === false && b.zh.saved === false,
    `emoji code ${b.em.code} with names (${b.em.chars.map(c => c.name).join(', ')})`);
  check(b.em.options[0].map(o => o.char).join('') === '🌃🌙' && b.em.options[1].map(o => o.char).join('') === '💡🔦🚗', `emoji choices skip newer and left-out emoji: ${b.em.options.map(p => p.map(o => o.char).join('')).join(' | ')}`);
  const prompt = env.AI.calls[0].input.messages[1].content;
  check(/never quote lyrics/.test(prompt) && prompt.includes('𓇰 night: night, darkness') && prompt.includes('😁😂🙃') && !prompt.includes('🍆') && !prompt.includes('English:') && prompt.endsWith('/no_think') && env.AI.calls[0].model === '@cf/qwen/qwen3-30b-a3b-fp8',
    'prompt names the song, lists the 98 signs and the emoji set, forbids quoting lyrics, turns thinking off (no English codes for songs)');
  check(one(env, 'SELECT COUNT(*) AS n FROM song_codes').n === 0, 'suggesting saves nothing');
}
// 2. Taken codes and look-alikes are skipped; real words get their dictionary meaning
{
  const env = await newEnv({ AI: fakeAI([goodAnswer]) });
  seedCode(env, '夜光', 'zh', ID2); seedCode(env, '𓇰𓇶', 'eg', ID2);
  const [, b] = await post('/suggest', { type: 'track', id: ID1 }, env);
  check(b.zh.code === '星光' && b.zh.word === 'starlight' && b.eg.code === '𓇼𓊮', `taken 夜光/𓇰𓇶 skipped -> ${b.zh.code} ("${b.zh.word}"), ${b.eg.code}`);
  const lookalike = { ...goodAnswer, zh: [{ code: '自光', chars: [{ char: '自', meaning: 'self' }, { char: '光', meaning: 'light' }], why: 'x' }, ...goodAnswer.zh] };
  const env2 = await newEnv({ AI: fakeAI([lookalike]) });
  await post('/claim', { type: 'track', id: ID2, zh: { code: '白光', chars: [] } }, env2);
  const [, b2] = await post('/suggest', { type: 'track', id: ID1 }, env2);
  check(b2.zh.code === '夜光', `自光 is skipped because 白光 exists -> ${b2.zh.code}`);
  const env3 = await newEnv({ AI: fakeAI([goodAnswer]) });
  seedCode(env3, '夜光', 'zh', ID2); seedCode(env3, '星光', 'zh', ID3);
  const [, b3] = await post('/suggest', { type: 'track', id: ID1 }, env3);
  check(b3.zh.code === '夜光火' && b3.zh.chars.length === 3 && !b3.zh.taken, `all 2-character codes taken -> adds a third: ${b3.zh.code}`);
}
// 3. Messy AI answers
{
  const env = await newEnv({ AI: fakeAI(['Sorry, I cannot help with that.', goodAnswer]) });
  const [st, b] = await post('/suggest', { type: 'track', id: ID1 }, env);
  check(st === 200 && b.zh.code === '夜光' && env.AI.calls.length === 2, 'an answer that isn\'t JSON is retried once');
  const env2 = await newEnv({ AI: fakeAI(['nope', 'still nope']) });
  const [st2, b2] = await post('/suggest', { type: 'track', id: ID1 }, env2);
  check(st2 === 502 && /Try again/.test(b2.error), `two bad answers -> ${st2} "${b2.error}"`);
  const env3 = await newEnv({ AI: { async run() { return { response: goodAnswer }; } } });
  const [st3, b3] = await post('/suggest', { type: 'track', id: ID1 }, env3);
  check(st3 === 200 && b3.zh.code === '夜光', 'an answer that is already an object works too');
}
// 3b. Workers AI failing outright
{
  const logs = [];
  const log = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  let calls = 0;
  const outOfNeurons = { async run() { calls++; throw new Error('3036: You have used up your daily free allocation of 10,000 neurons. Please upgrade to Cloudflare\'s Workers Paid plan if you would like to continue usage.'); } };
  const env = await newEnv({ AI: outOfNeurons });
  const [st, b, h] = await post('/suggest', { type: 'track', id: ID1 }, env);
  const wait = Number(h.get('Retry-After')), songCalls = calls;
  const [stp, bp] = await post('/playlist/suggest', { items: `${ID1},${ID2}` }, env);
  const broken = { async run() { throw new Error('5007: No such model @cf/qwen/qwen3-30b-a3b-fp8'); } };
  const [st2, b2] = await post('/suggest', { type: 'track', id: ID1 }, await newEnv({ AI: broken }));
  const cut = { async run() { return { response: '{"zh":[{"code":"夜光","chars":[{"char":"夜","meaning":"ni' }; } };
  await post('/playlist/suggest', { items: `${ID1},${ID2}` }, await newEnv({ AI: cut }));
  console.log = log;
  check(st === 503 && /used up today's code suggestions/.test(b.error) && /come back in (about \d+ hours|under an hour)/.test(b.error) && wait > 0 && wait <= 86400 && songCalls === 1,
    `the daily limit -> ${st} "${b.error}", Retry-After ${wait}s, asked once`);
  check(stp === 503 && /used up today's code suggestions/.test(bp.error), `same for a playlist -> ${stp} "${bp.error}"`);
  check(st2 === 502 && /Try again/.test(b2.error), `another AI error still gives the usual message -> ${st2}`);
  check(logs.some(l => l.startsWith('Workers AI failed: 5007: No such model')) && logs.some(l => l.startsWith('Workers AI failed: 3036')),
    'AI errors are logged, so `wrangler tail` shows them');
  check(logs.some(l => /^Workers AI reply wasn't JSON \(\d+ chars\), ending: .*"meaning":"ni$/.test(l)), 'a cut-off reply is logged with how it ends');
}
// 4. Claiming, then the same song gets the same codes
{
  const env = await newEnv({ AI: fakeAI([goodAnswer]) });
  const [, s] = await post('/suggest', { type: 'track', id: ID1 }, env);
  const [st, c] = await post('/claim', { type: 'track', id: ID1, zh: s.zh, eg: s.eg, em: s.em }, env);
  check(st === 200 && c.zh.code === '夜光' && c.eg.code === '𓇰𓇶' && c.em.code === '🌃💡' && c.zh.chars[0].meaning === 'night' && c.eg.chars[1].name === 'sunshine' && c.em.saved, `claim saves ${c.zh.code} + ${c.eg.code} + ${c.em.code} and returns their meanings`);
  const r = one(env, 'SELECT track, why, chars FROM song_codes WHERE code = ?', '夜光');
  check(r.track === ID1 && r.why === 'Neon city nights, chasing someone' && JSON.parse(r.chars)[0].meaning === 'night' && all(env, 'SELECT * FROM song_codes WHERE track = ?', ID1).length === 3,
    'the codes are stored in the database with their meanings');
  const [, again] = await post('/suggest', { type: 'track', id: ID1 }, { DB: env.DB, AI: fakeAI(['should not be called']) });
  check(again.existing && again.zh.code === '夜光' && again.zh.chars[0].meaning === 'night' && again.eg.chars[1].name === 'sunshine' && again.em.code === '🌃💡' && again.em.saved, 'asking again returns the same three codes without the AI');
  const [st2, c2] = await post('/claim', { type: 'track', id: ID1, zh: { code: '星光' }, eg: { code: '𓇼𓊮' } }, env);
  check(st2 === 200 && c2.existing && c2.zh.code === '夜光' && c2.zh.why === 'Neon city nights, chasing someone', 'a second claim for the same song keeps (and returns) the first codes');
  const [st3, c3] = await post('/claim', { type: 'track', id: ID2, zh: { code: '夜光' } }, env);
  check(st3 === 409 && c3.taken && c3.code === '夜光', `another song can't take 夜光 (${st3})`);
  const [st4] = await post('/claim', { type: 'track', id: ID2, zh: { code: '傻逼' } }, env);
  const [st5] = await post('/claim', { type: 'track', id: ID2, eg: { code: '𓀀𓇶' } }, env);
  const [st6] = await post('/claim', { type: 'track', id: ID2, zh: { code: '夜' } }, env);
  check(st4 === 400 && st5 === 400 && st6 === 400, 'blocked words, signs outside the set and 1-character codes are refused');
  const env2 = await newEnv();
  await post('/claim', { type: 'track', id: ID2, zh: { code: '白光', chars: [] } }, env2);
  const [st7] = await post('/claim', { type: 'track', id: ID3, zh: { code: '自光' } }, env2);
  check(all(env2, 'SELECT * FROM zh_shapes').length === 1 && st7 === 409, 'claiming 白光 blocks the look-alike 自光');
  const [st8] = await post('/claim', { type: 'track', id: ID3, em: { code: '🍆💦' } }, env);
  const [st9] = await post('/claim', { type: 'track', id: ID3, em: { code: '🌃' } }, env);
  const [st10, c10] = await post('/claim', { type: 'track', id: ID3, em: { code: '🌙️🚗' } }, env);
  check(st8 === 400 && st9 === 400 && st10 === 200 && c10.em.code === '🌙🚗', 'left-out emoji and 1-emoji codes are refused; an emoji with a style marker (U+FE0F) still counts');
  const [st11, c11] = await post('/claim', { type: 'track', id: 'Q'.repeat(22), zh: { code: '月光' } }, env);
  check(st11 === 404 && /Couldn't find this song/.test(c11.error) && !one(env, 'SELECT 1 AS x FROM song_codes WHERE code = ?', '月光'), 'a made-up song ID can\'t get codes');
}
// 4b. A song saved before emoji codes existed gains one, and keeps its other codes
{
  const env = await newEnv({ AI: fakeAI([goodAnswer]) });
  env.DB.sql.prepare("INSERT INTO song_codes (code, script, track, chars, why, created) VALUES ('夜光', 'zh', ?, ?, 'old why', 'x')").run(ID1, JSON.stringify([{ char: '夜', meaning: 'night' }, { char: '光', meaning: 'light' }]));
  seedCode(env, '𓇰𓇶', 'eg', ID1);
  const [, s] = await post('/suggest', { type: 'track', id: ID1 }, env);
  check(s.zh.saved && s.zh.why === 'old why' && s.eg.saved && s.em && !s.em.saved && s.em.code === '🌃💡', 'only the missing emoji code is suggested; saved codes come back marked saved');
  const [st, c] = await post('/claim', { type: 'track', id: ID1, zh: { code: '星光' }, eg: { code: '𓇼𓊮' }, em: s.em }, env);
  const kinds = all(env, 'SELECT code, script FROM song_codes WHERE track = ? ORDER BY script', ID1).map(r => r.script + ':' + r.code).join(' ');
  check(st === 200 && kinds === 'eg:𓇰𓇶 em:🌃💡 zh:夜光' && c.zh.code === '夜光' && c.em.code === '🌃💡', `saving adds the emoji code without touching the others (${kinds})`);
}
// 5. Two people at the same moment (the race a "check, then save" can lose)
{
  const env = await newEnv();
  const results = await Promise.all([
    post('/claim', { type: 'track', id: ID1, zh: { code: '夜光' } }, env),
    post('/claim', { type: 'track', id: ID2, zh: { code: '夜光' } }, env),
  ]);
  const statuses = results.map(r => r[0]).sort().join(',');
  const owners = all(env, 'SELECT track FROM song_codes WHERE code = ?', '夜光');
  check(statuses === '200,409' && owners.length === 1, `two songs claiming 夜光 at once: one gets it, the other is told (${statuses}); stored once`);
  const loser = results.find(r => r[0] === 409)[1];
  check(/just went to another song|already belongs/.test(loser.error), `the other person sees: "${loser.error}"`);
  const env2 = await newEnv();
  const same = await Promise.all([
    post('/claim', { type: 'track', id: ID3, zh: { code: '星光' }, em: { code: '🌙🚗' } }, env2),
    post('/claim', { type: 'track', id: ID3, zh: { code: '月光' }, em: { code: '🌃💡' } }, env2),
  ]);
  const kinds = all(env2, 'SELECT script FROM song_codes WHERE track = ?', ID3).map(r => r.script).sort().join(',');
  check(same.every(r => r[0] === 200) && same[0][1].zh.code === same[1][1].zh.code && kinds === 'em,zh', `two people saving one song at once end up with the same codes (${same[0][1].zh.code}), one of each kind`);
}
// 6. Setup problems and plumbing
{
  const [st, b] = await post('/suggest', { type: 'track', id: ID1 }, await newEnv());
  check(st === 503 && /suggestions aren't set up/.test(b.error), `no AI binding -> 503 "${b.error}"`);
  const [st2, b2] = await post('/claim', { type: 'track', id: ID1, zh: { code: '夜光' } }, {});
  check(st2 === 503 && /DB binding/.test(b2.error), 'no database binding -> 503 that says what\'s missing');
  const [st3] = await post('/suggest', { type: 'track', id: 'short' }, await newEnv({ AI: fakeAI([goodAnswer]) }));
  check(st3 === 400, 'a bad song id -> 400');
  const opt = await worker.fetch(new Request('https://w.dev/claim', { method: 'OPTIONS' }), {});
  check(opt.headers.get('access-control-allow-methods') === 'GET, POST, OPTIONS' && /Authorization/.test(opt.headers.get('access-control-allow-headers')), 'preflight allows POST and sign-in headers from spotiky.com');
  const env = await newEnv();
  seedCode(env, '夜光', 'zh', ID1);
  const [st4, g] = await get('/codes?c=' + encodeURIComponent('夜光'), env);
  check(st4 === 200 && g['夜光'].id === ID1 && g['夜光'].type === 'track', 'looking codes up works');
  const fresh = { DB: (await import('./d1.mjs')).makeDB() };
  const [st5, g5] = await get('/codes?c=' + encodeURIComponent('夜光'), fresh);
  check(st5 === 200 && g5['夜光'] === null, 'a brand-new database makes its own tables on the first request');
}
// 7. Skin tones: 👋🏾🌙, 👋🏿🌙 and 👋🌙 are one code, saved without a tone
{
  const env = await newEnv({ AI: fakeAI([{ ...goodAnswer, em: [{ code: '👋🏾🌙', why: 'Waving goodbye at night' }, ...goodAnswer.em], em_alts: [['🙌🏿', '🌃'], ['🌙', '🔦']] }]) });
  const [, s] = await post('/suggest', { type: 'track', id: ID1 }, env);
  const opts = s.em.options.map(p => p.map(o => o.char).join('')).join(' | ');
  check(s.em.code === '👋🌙' && s.em.chars[0].toneable === true && s.em.chars[1].toneable === false && opts === '👋🙌🌃🌙 | 🌙🔦💡🚗' && !TONE.test(JSON.stringify(s)),
    `a tone the AI adds is dropped (${s.em.code}), 👋 is marked toneable and 🌙 isn't; choices ${opts}`);
  check(/no skin tone; the person sharing picks one/.test(env.AI.calls[0].input.messages[1].content), 'the prompt asks for people and hands in their default color');
  const [st, c] = await post('/claim', { type: 'track', id: ID1, em: { code: '👋🏽🌙', why: 'Waving goodbye at night' } }, env);
  check(st === 200 && c.em.code === '👋🌙' && c.em.chars[0].toneable && !all(env, 'SELECT code FROM song_codes').some(r => TONE.test(r.code)), 'a code claimed with a tone is saved without it');
  const [st2, c2] = await post('/claim', { type: 'track', id: ID2, em: { code: '👋🏿🌙' } }, env);
  check(st2 === 409 && c2.taken, `another song can't take the same code in another tone (${st2})`);
  const [, gb] = await get('/codes?c=' + encodeURIComponent('👋🏾🌙,👋🌙,👋🏻🌙️,🌙🏾💡'), env);
  check(gb['👋🏾🌙'].id === ID1 && gb['👋🌙'].id === ID1 && gb['👋🏻🌙'].id === ID1 && gb['🌙🏾💡'] === null && Object.keys(gb).length === 4,
    `lookups work in any tone and answer under the code as asked: ${Object.keys(gb).join(' ')}`);
}
// 8. Reading songs from Spotify, as its pages are now
{
  const ask = async id => {
    const env = await newEnv({ AI: fakeAI([goodAnswer]) });
    const [st, b] = await post('/suggest', { type: 'track', id }, env);
    return [st, b, env.AI.calls.length ? env.AI.calls[0].input.messages[1].content : ''];
  };
  let [st, b, prompt] = await ask(ID2);
  check(st === 200 && prompt.includes('the song "Ocean Eyes" by Billie Eilish'), 'the title comes from oEmbed and the artist from the embed page');
  spotify.oembedDown = true;
  [st, b, prompt] = await ask(ID2);
  check(st === 200 && prompt.includes('the song "Ocean Eyes" by Billie Eilish'), 'if oEmbed is down, the embed page\'s heading gives the title');
  spotify.oembedDown = false;
  const ID4 = 'D'.repeat(21) + '4', ID5 = 'E'.repeat(21) + '5';
  SONGS[ID4] = ['The Boxer', '']; SONGS[ID5] = ['Mrs. Robinson', ''];
  PAGES[ID4] = '<html><script>{"entity":{"name":"The Boxer","artists":[{"name":"Simon \\u0026 Garfunkel","uri":"spotify:artist:1"},{"name":"Paul Simon","uri":"spotify:artist:2"}]}}</script></html>';
  PAGES[ID5] = `<html><body><h1>Mrs. Robinson</h1><a class="a" href="/artist/${'Y'.repeat(22)}"><span>Simon &amp; Garfunkel</span></a> <a href="/artist/${'X'.repeat(22)}">Paul Simon</a></body></html>`;
  [st, b, prompt] = await ask(ID4);
  check(prompt.includes('"The Boxer" by Simon & Garfunkel, Paul Simon'), `several artists from the page's data: ${prompt.match(/the song (.*)/)[1]}`);
  [st, b, prompt] = await ask(ID5);
  check(prompt.includes('"Mrs. Robinson" by Simon & Garfunkel, Paul Simon'), `several artist links, with &amp; decoded: ${prompt.match(/the song (.*)/)[1]}`);
  [st, b] = await ask('F'.repeat(21) + '7');
  check(st === 502 && /Couldn't read this song/.test(b.error), 'a song Spotify knows nothing about still gets a clear error');
  const pv = await worker.fetch(new Request('https://w.dev/?id=' + ID1), {});
  const pj = await pv.json();
  check(pv.status === 200 && pj.name === 'Blinding Lights' && pj.preview_url === 'https://p.scdn.co/mp3-preview/abc', `the preview route names the song: ${JSON.stringify(pj)}`);
}
T.done();
