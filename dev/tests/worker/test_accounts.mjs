// Sign-in (email + code) and playlists (ID + four labels, snapshots and owned) in the Worker
import { webcrypto } from 'node:crypto';
import { ID1, ID2, ID3, resend, goodAnswer, fakeAI, newEnv, post, get, one, all, seedCode, T } from './fakes.mjs';
import { everything } from './d1.mjs';
const check = T.check.bind(T);
const SECRETS = { PEPPER: 'a-long-random-pepper-for-tests-0123456789abcdef', RESEND_API_KEY: 're_test_key' };
const lastCode = () => (resend.sent[resend.sent.length - 1].text.match(/\b(\d{6})\b/) || [])[1];
const A = '0123456789abcdefghjkmnpqrstvwxyz';
const base32 = bytes => { let o = '', n = 0, b = 0; for (const x of bytes) { n = (n << 8) | x; b += 8; while (b >= 5) { b -= 5; o += A[(n >> b) & 31]; } n &= (1 << b) - 1; } return b ? o + A[(n << (5 - b)) & 31] : o; };
const fingerprint = async s => base32(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
// An ID's start with no digit gets its last letter turned into one, as the Worker does
const withDigit = id => /[0-9]/.test(id) ? id : id.slice(0, -1) + String(A.indexOf(id[id.length - 1]) % 10);

async function signIn(env, email, ip = '1.2.3.4') {
  await post('/auth/start', { email }, env, { ip });
  const [, b] = await post('/auth/verify', { email, code: lastCode() }, env);
  return b.token;
}

console.log('### Signing in with email + a code');
{
  const [st0, b0] = await post('/auth/start', { email: 'me@example.com' }, await newEnv());
  check(st0 === 503 && /isn't set up/.test(b0.error), `without the PEPPER and RESEND_API_KEY secrets: ${st0} "${b0.error}"`);
  const env = await newEnv(SECRETS);
  const [st1] = await post('/auth/start', { email: 'not an email' }, env);
  check(st1 === 400, 'a bad email address -> 400');
  const [st, b] = await post('/auth/start', { email: '  Me@Example.com ' }, env, { ip: '1.2.3.4' });
  const mail = resend.sent[resend.sent.length - 1];
  check(st === 200 && b.sent && mail.to[0] === 'me@example.com' && /^Your Spotiky code: \d{6}$/.test(mail.subject) && mail.auth === 'Bearer re_test_key' && /works for 10 minutes/.test(mail.text),
    `the code is emailed through Resend: "${mail.subject}" to ${mail.to[0]}`);
  const code = lastCode();
  check(!everything(env.DB).some(v => /example\.com/i.test(v) || v.includes(code)), 'the database holds no email address and no code, only hashes');
  const wrong = code === '000000' ? '111111' : '000000';
  const [st2, b2] = await post('/auth/verify', { email: 'me@example.com', code: wrong }, env);
  check(st2 === 400 && b2.triesLeft === 4, `a wrong code -> "${b2.error}" (${b2.triesLeft} tries left)`);
  const [st3, b3] = await post('/auth/verify', { email: 'ME@example.com', code: code.slice(0, 3) + ' ' + code.slice(3) }, env);
  check(st3 === 200 && /^[A-Za-z0-9_-]{43}$/.test(b3.token) && b3.expires > Date.now() + 29 * 86400e3, 'the right code (any capitals in the email, a space in the code) signs in for 30 days');
  check(!everything(env.DB).includes(b3.token) && all(env, 'SELECT * FROM owners').length === 1 && all(env, 'SELECT * FROM sessions').length === 1,
    'the account is made on first sign-in; the sign-in token is stored only as a hash');
  const [st4, b4] = await post('/auth/verify', { email: 'me@example.com', code }, env);
  check(st4 === 400 && b4.expired, 'a code works only once');
  const [st5, b5] = await get('/auth/me', env, { token: b3.token });
  const [st6] = await get('/auth/me', env);
  const [st6b] = await get('/auth/me', env, { token: 'x'.repeat(43) });
  check(st5 === 200 && b5.signedIn && st6 === 401 && st6b === 401, '/auth/me knows a signed-in request from one without a sign-in or with a made-up token');
  const token2 = await signIn(env, 'me@example.com');
  check(all(env, 'SELECT * FROM owners').length === 1 && all(env, 'SELECT DISTINCT owner FROM sessions').length === 1, 'signing in again with the same email is the same account');
  await post('/auth/signout', {}, env, { token: token2 });
  const [st7] = await get('/auth/me', env, { token: token2 });
  const [st8] = await get('/auth/me', env, { token: b3.token });
  check(st7 === 401 && st8 === 200, 'signing out ends that sign-in only');
}
{
  const env = await newEnv(SECRETS);
  await post('/auth/start', { email: 'x@example.com' }, env, { ip: '5.5.5.5' });
  for (let i = 0; i < 5; i++) await post('/auth/verify', { email: 'x@example.com', code: '999999' === lastCode() ? '888888' : '999999' }, env);
  const [st, b] = await post('/auth/verify', { email: 'x@example.com', code: lastCode() }, env);
  check(st === 429 && /new code/.test(b.error), `after 5 wrong tries even the right code is refused: "${b.error}"`);
  env.DB.sql.prepare('UPDATE sign_in_codes SET expires = 0').run();
  await post('/auth/start', { email: 'y@example.com' }, env, { ip: '5.5.5.5' });
  env.DB.sql.prepare('UPDATE sign_in_codes SET expires = 0').run();
  const [st2, b2] = await post('/auth/verify', { email: 'y@example.com', code: lastCode() }, env);
  check(st2 === 400 && b2.expired, 'a code older than 10 minutes has expired');
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await post('/auth/start', { email: 'z@example.com' }, env, { ip: '6.6.6.' + i }))[0]);
  check(codes.join(',') === '200,200,200,429', `3 codes per email every 15 minutes: ${codes.join(',')}`);
  const ips = [];
  for (let i = 0; i < 11; i++) ips.push((await post('/auth/start', { email: `p${i}@example.com` }, env, { ip: '7.7.7.7' }))[0]);
  check(ips.slice(0, 10).every(s => s === 200) && ips[10] === 429, '10 codes per connection every hour');
  resend.down = true;
  const [st3, b3] = await post('/auth/start', { email: 'q@example.com' }, env, { ip: '8.8.8.8' });
  resend.down = false;
  check(st3 === 502 && /Couldn't send/.test(b3.error), `Resend down -> "${b3.error}"`);
}

console.log('\n### Playlists: an ID and a set of four labels');
const ITEMS = `${ID1}$83,夜光4-8,${ID3}`;
{
  const env = await newEnv({ ...SECRETS, AI: fakeAI([goodAnswer]) });
  seedCode(env, '夜光', 'zh', ID2);
  const [st, s] = await post('/playlist/suggest', { items: ITEMS }, env);
  const prompt = env.AI.calls[0].input.messages[1].content;
  const expected = withDigit((await fingerprint(ITEMS)).slice(0, 3));
  check(st === 200 && s.id === expected && !s.saved && !s.mine, `a new playlist's ID is the start of its fingerprint: ${s.id}`);
  check(s.labels.zh.code === '夜光' && s.labels.eg.code === '𓇰𓇶' && s.labels.em.code === '🌃💡' && s.labels.en.code === 'night-drive',
    `four labels: ${['zh', 'eg', 'em', 'en'].map(k => s.labels[k].code).join(' ')} (夜光 is a song's code, but labels can repeat)`);
  check(s.labels.en.chars.map(c => c.char).join('/') === 'night/drive' && s.labels.en.options[0].map(o => o.char).join(',') === 'night,late,city,neon'
    && s.labels.en.options[1].map(o => o.char).join(',') === 'drive,ride,glow', `English words swap like characters; bad words and capitals are cleaned out: ${s.labels.en.options.map(p => p.map(o => o.char).join(',')).join(' | ')}`);
  check(/English: give 3 different labels/.test(prompt) && /a playlist of these songs:\n1\. "Blinding Lights" by The Weeknd\n2\. "Ocean Eyes" by Billie Eilish\n3\. "Dreams"/.test(prompt) && !all(env, 'SELECT * FROM playlists').length,
    'the prompt lists the songs (codes looked up) and asks for English too; suggesting saves nothing');
  const labels = { zh: s.labels.zh, eg: s.labels.eg, em: { ...s.labels.em, code: '🌃🏾💡' }, en: s.labels.en };
  const [st2, saved] = await post('/playlist/save', { items: ITEMS, labels }, env, { ip: '9.9.9.9' });
  const rowSaved = one(env, 'SELECT * FROM playlists WHERE id = ?', saved.id);
  check(st2 === 200 && saved.id === expected && saved.saved && !saved.mine && rowSaved.owner === null && JSON.parse(rowSaved.labels).em.code === '🌃💡',
    `saving makes a snapshot ${saved.id} that nobody owns (labels saved without skin tones)`);
  const [, again] = await post('/playlist/suggest', { items: ITEMS.replace('夜光', '夜光') }, { ...env, AI: fakeAI(['should not be called']) });
  check(again.saved && again.id === expected && again.labels.en.code === 'night-drive', 'the same songs and times later get the same snapshot back, without the AI');
  const [st3, g] = await get('/playlist?id=' + expected.toUpperCase(), env);
  check(st3 === 200 && g.items === ITEMS && g.labels.zh.code === '夜光' && g.labels.eg.chars[0].name === 'night' && g.labels.em.chars[0].name === 'night with stars' && !g.mine && !g.owned,
    'GET /playlist returns its songs and described labels (capitals in the ID are fine)');
  const [st4] = await get('/playlist?id=zzz9', env);
  const [st5] = await get('/playlist?id=il0', env);
  const [st5b] = await get('/playlist?id=zzzz', env);
  check(st4 === 404 && st5 === 400 && st5b === 400, 'an unknown ID -> 404; letters that IDs never use, or no digit -> 400');
  const other = `${ID2},${ID3}$10`;
  const collide = withDigit((await fingerprint(other)).slice(0, 3));
  env.DB.sql.prepare("INSERT INTO playlists (id, items, hash, owner, labels, created, updated) VALUES (?, 'x', 'y', 'someone', '{}', 'x', 'x')").run(collide);
  const [, s2] = await post('/playlist/save', { items: other, labels }, env, { ip: '9.9.9.9' });
  check(s2.id === withDigit((await fingerprint(other)).slice(0, 4)), `when another playlist has those 3 characters, the next one gets 4: ${collide} taken -> ${s2.id}`);
  const [st6, b6] = await post('/playlist/save', { items: other + ',' + ID1, labels: { ...labels, en: { code: 'fuck-yeah' } } }, env);
  const [st7] = await post('/playlist/save', { items: other + ',' + ID1, labels: { ...labels, en: { code: 'one-two-three' } } }, env);
  const [st8] = await post('/playlist/save', { items: 'not,a,playlist<', labels }, env);
  check(st6 === 400 && b6.kind === 'en' && st7 === 400 && st8 === 400, `bad English labels and broken playlists are refused: "${b6.error}"`);
}
{
  const env = await newEnv({ ...SECRETS, AI: fakeAI([goodAnswer]) });
  const alice = await signIn(env, 'alice@example.com', '1.1.1.1');
  const bob = await signIn(env, 'bob@example.com', '2.2.2.2');
  const [, s] = await post('/playlist/suggest', { items: ITEMS }, env, { token: alice });
  check(s.mine && /^(?=.*[0-9])[0-9a-hjkmnp-tv-z]{3}$/.test(s.id) && s.idSig, `signed in, the playlist will be yours, with its own ID: ${s.id}`);
  const [st, own] = await post('/playlist/save', { items: ITEMS, labels: s.labels, id: s.id, idSig: s.idSig }, env, { token: alice });
  check(st === 200 && own.id === s.id && own.mine && own.owned, `saved as Alice's playlist under the ID she was shown: ${own.id}`);
  const [, forged] = await post('/playlist/save', { items: ITEMS + ',' + ID2, labels: s.labels, id: 'abc', idSig: 'f'.repeat(64) }, env, { token: alice });
  check(forged.id !== 'abc' && forged.mine, `nobody can pick their own ID by sending one (got ${forged.id}, not abc)`);
  const [, viewer] = await get('/playlist?id=' + own.id, env);
  const [, viewerBob] = await get('/playlist?id=' + own.id, env, { token: bob });
  const [, viewerAlice] = await get('/playlist?id=' + own.id, env, { token: alice });
  check(!viewer.mine && viewer.owned && !viewerBob.mine && viewerAlice.mine, 'only Alice sees it as hers');
  const edited = `${ID3}$20,${ID1}`;
  const [st2, e] = await post('/playlist/save', { edit: own.id, items: edited }, env, { token: alice });
  const [, after] = await get('/playlist?id=' + own.id, env);
  check(st2 === 200 && e.id === own.id && after.items === edited && after.labels.zh.code === '夜光', `Alice edits her playlist and the link stays ${own.id}`);
  const [st3] = await post('/playlist/save', { edit: own.id, items: ID2 }, env, { token: bob });
  const [st4] = await post('/playlist/save', { edit: own.id, items: ID2 }, env);
  const [, still] = await get('/playlist?id=' + own.id, env);
  check(st3 === 403 && st4 === 401 && still.items === edited, 'Bob can\'t change it (403), and neither can someone signed out (401)');
  const [, snap] = await post('/playlist/save', { items: ITEMS, labels: s.labels }, env, { ip: '3.3.3.3' });
  check(!snap.owned && snap.id !== own.id, `a signed-out save of the same songs is a separate snapshot (${snap.id})`);
  const [, bobs] = await post('/playlist/suggest', { items: ITEMS }, { ...env, AI: fakeAI(['should not be called']) }, { token: bob });
  check(bobs.mine && !bobs.saved && bobs.labels.zh.code === '夜光' && bobs.id !== snap.id, 'Bob making his own copy of that snapshot starts from its labels, no AI needed');
  const [st5, mine] = await get('/playlists/mine', env, { token: alice });
  const [st6] = await get('/playlists/mine', env);
  check(st5 === 200 && mine.playlists.length === 2 && mine.playlists.every(p => p.mine && p.items) && st6 === 401, `Alice's playlists list has her 2; signed out -> 401`);
}
T.done();
