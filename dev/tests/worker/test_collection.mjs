// A signed-in person's collection in the Worker: renaming (a few times a day), matching labels,
// the featured shelf and crates, deleting and restoring, liner notes, codes you named, the sets.
import { ID1, ID2, ID3, resend, goodAnswer, fakeAI, newEnv, post, get, all, T } from './fakes.mjs';
const check = T.check.bind(T);
const SECRETS = { PEPPER: 'a-long-random-pepper-for-tests-0123456789abcdef', RESEND_API_KEY: 're_test_key' };
const lastCode = () => (resend.sent[resend.sent.length - 1].text.match(/\b(\d{6})\b/) || [])[1];
async function signIn(env, email, ip) {
  await post('/auth/start', { email }, env, { ip });
  const [, b] = await post('/auth/verify', { email, code: lastCode() }, env);
  return b.token;
}
const codes = labels => Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, v.code]));

const ai = fakeAI([goodAnswer]);
const env = await newEnv({ ...SECRETS, AI: ai });
const alice = await signIn(env, 'alice@example.com', '1.1.1.1');
const bob = await signIn(env, 'bob@example.com', '2.2.2.2');
const ITEMS = `${ID1}$4-8,${ID2}`;

console.log('### Naming it yourself when it is made');
const [, s] = await post('/playlist/suggest', { items: ITEMS }, env, { token: alice });
const labels = { ...s.labels, en: { code: 'night-drive' } };
const [st0, own] = await post('/playlist/save', { items: ITEMS, labels, typed: undefined, id: s.id, idSig: s.idSig }, env, { token: alice });
check(st0 === 200 && own.typed.length === 0 && own.renamesLeft === 3, `saved with no typed labels: typed [${own.typed}], ${own.renamesLeft} renames left`);
const [, own2] = await post('/playlist/save', { items: `${ID3}`, labels: { ...labels, typed: ['en', 'xx'] } }, env, { token: alice });
check(JSON.stringify(own2.typed) === '["en"]', `a label the person typed is marked as theirs (unknown kinds dropped): [${own2.typed}]`);
const [, pub] = await get('/playlist?id=' + own2.id, env);
const [, mine] = await get('/playlist?id=' + own2.id, env, { token: alice });
check(JSON.stringify(pub.typed) === '["en"]' && pub.pinned === undefined && pub.renamesLeft === undefined && mine.pinned === false && mine.crate === null && mine.renamesLeft === 3,
  'anyone sees which label is typed; only the owner sees pins, crate and renames left');

console.log('\n### Renaming');
const id = own.id;
const [stA] = await post('/playlist/rename', { id, labels: { ...labels, zh: { code: '月光' } }, typed: ['zh'] }, env);
const [stB] = await post('/playlist/rename', { id, labels: { ...labels, zh: { code: '月光' } }, typed: ['zh'] }, env, { token: bob });
check(stA === 401 && stB === 403, 'signed out -> 401; someone else -> 403');
const [stC, bad] = await post('/playlist/rename', { id, labels: { ...labels, zh: { code: '龘靐' } }, typed: ['zh'] }, env, { token: alice });
check(stC === 400 && bad.kind === 'zh', `a label outside the rules says which one: "${bad.error}"`);
const [stD, r1] = await post('/playlist/rename', { id, labels: { ...labels, zh: { code: '月光' } }, typed: ['zh'] }, env, { token: alice });
check(stD === 200 && r1.labels.zh.code === '月光' && r1.labels.en.code === 'night-drive' && JSON.stringify(r1.typed) === '["zh"]' && r1.renamesLeft === 2,
  `renaming one label keeps the others: ${Object.values(codes(r1.labels)).join(' ')}, ${r1.renamesLeft} left`);
const [, same] = await post('/playlist/rename', { id, labels: r1.labels, typed: ['zh'] }, env, { token: alice });
check(same.unchanged && same.renamesLeft === 2, 'sending the same labels changes nothing and spends no rename');
const [, r2] = await post('/playlist/rename', { id, labels: { ...r1.labels, en: { code: 'moon-drive' } }, typed: ['zh', 'en'] }, env, { token: alice });
const [, r3] = await post('/playlist/rename', { id, labels: { ...r2.labels, em: { code: '🌙🚗' } }, typed: ['zh', 'en', 'em'] }, env, { token: alice });
const [stE, r4] = await post('/playlist/rename', { id, labels: { ...r3.labels, en: { code: 'neon' } }, typed: ['zh', 'en', 'em'] }, env, { token: alice });
check(r2.renamesLeft === 1 && r3.renamesLeft === 0 && stE === 429 && r4.renamesLeft === 0 && Date.parse(r4.nextAt) > Date.now() + 23 * 3600e3,
  `3 renames a day, then "${r4.error}" (next one ${r4.nextAt.slice(0, 16)})`);
const [, viaLink] = await get('/playlist?id=' + id, env);
check(viaLink.labels.en.code === 'moon-drive' && viaLink.labels.em.code === '🌙🚗', 'the ID still opens it, with the new labels');
const [, hist] = await get('/playlist/history?id=' + id, env);
const kinds = hist.history.map(x => x.kind).join(',');
check(kinds === 'rename,rename,rename,born' && hist.history[0].from.en === 'moon-drive' && hist.history[0].to.em === '🌙🚗' && JSON.stringify(hist.history[0].typed) === '["zh","em","en"]'
  && hist.history[3].labels.en === 'night-drive', `the trail, newest first: ${kinds} (each rename with before, after and the typed labels)`);
env.DB.sql.prepare("UPDATE playlist_history SET at = '2020-01-01T00:00:00.000Z' WHERE list = ? AND kind = 'rename'").run(id);
const [stF, r5] = await post('/playlist/rename', { id, labels: { ...r3.labels, en: { code: 'neon' } }, typed: ['zh', 'en', 'em'] }, env, { token: alice });
check(stF === 200 && r5.renamesLeft === 2, 'renames older than a day stop counting');

console.log('\n### Matching the other labels to the ones you typed');
ai.calls.length = 0;
const [stG, m] = await post('/labels', { fixed: { en: 'Night Drive' }, id, match: true }, env, { token: alice });
const prompt = ai.calls[0] && ai.calls[0].input.messages.map(x => x.content).join('\n');
check(stG === 200 && m.labels.en.code === 'night-drive' && m.labels.en.typed && m.labels.zh.matched && m.labels.eg.matched && m.labels.em.matched,
  `typing English matches Chinese, hieroglyphs and emoji: ${['zh', 'eg', 'em', 'en'].map(k => m.labels[k].code).join(' ')}`);
check(/English "night-drive"/.test(prompt) && /Blinding Lights/.test(prompt) && /Ocean Eyes/.test(prompt), 'the AI is told the typed label and, by the playlist ID, its songs');
check(m.labels.zh.alternates.length >= 1 && m.labels.zh.alternates[0].code !== m.labels.zh.code && m.labels.em.alternates.every(a => a.matched),
  `each match comes with alternates to reroll through: zh ${[m.labels.zh.code, ...m.labels.zh.alternates.map(a => a.code)].join(' / ')}`);
ai.calls.length = 0;
const [, m2] = await post('/labels', { fixed: { zh: '夜歌', en: 'night-drive' }, id, match: true }, env, { token: alice });
const prompt2 = ai.calls[0].input.messages.map(x => x.content).join('\n');
check(m2.labels.zh.typed && m2.labels.en.typed && m2.labels.eg.matched && m2.labels.em.matched && /Chinese "夜歌" and English "night-drive"/.test(prompt2) && !/^Chinese: give 3/m.test(prompt2),
  'typing two labels matches only the other two');
const [stH, b2] = await post('/labels', { fixed: { em: '🍆💦' }, id, match: true }, env);
const [, check1] = await post('/labels', { fixed: { eg: '𓇰𓇶' } }, env);
check(stH === 400 && b2.kind === 'em' && check1.labels.eg.chars[0].name === 'night' && !check1.labels.zh,
  `a typed label outside the set is refused before any AI call ("${b2.error}"); without match it's just checked and described`);

console.log('\n### The featured shelf and crates');
const ids = [id, own2.id];
for (const extra of [ID2, `${ID1},${ID3}`, `${ID3}$10`]) {
  const [, x] = await post('/playlist/save', { items: extra, labels }, env, { token: alice });
  ids.push(x.id);
}
const pins = [];
for (const x of ids) pins.push(await post('/playlist/shelf', { id: x, pinned: true }, env, { token: alice }));
check(pins.slice(0, 4).every(([st, b]) => st === 200 && b.pinned) && pins[4][0] === 409 && pins[4][1].full, `4 fit on the featured shelf; a 5th: "${pins[4][1].error}"`);
await post('/playlist/shelf', { id: ids[0], pinned: false }, env, { token: alice });
const [stI] = await post('/playlist/shelf', { id: ids[4], pinned: true }, env, { token: alice });
const [, c1] = await post('/playlist/shelf', { id: ids[1], crate: '  Late\tnight  ' }, env, { token: alice });
const [, c2] = await post('/playlist/shelf', { id: ids[2], crate: 'Gym' }, env, { token: alice });
const [stJ] = await post('/playlist/shelf', { id: ids[1], crate: 'x' }, env, { token: bob });
check(stI === 200 && c1.crate === 'Late night' && c1.pinned && c2.crate === 'Gym' && stJ === 403, 'unpinning frees a spot; crate names are tidied; only the owner can shelve');
const [, lib] = await get('/playlists/mine', env, { token: alice });
const byId = Object.fromEntries(lib.playlists.map(p => [p.id, p]));
check(lib.playlists.length === 5 && JSON.stringify(lib.crates) === '["Gym","Late night"]' && byId[ids[1]].crate === 'Late night' && !byId[ids[0]].pinned && byId[ids[4]].pinned
  && byId[id].renamesLeft === 2 && lib.maxPinned === 4 && lib.renamesPerDay === 3, `your playlists come with pins, crates and renames left (crates: ${lib.crates.join(', ')})`);
await post('/playlist/shelf', { id: ids[2], crate: null }, env, { token: alice });
const [, lib2] = await get('/playlists/mine', env, { token: alice });
check(JSON.stringify(lib2.crates) === '["Late night"]', 'a crate with nothing in it is gone');

console.log('\n### Deleting and restoring');
const [stK] = await post('/playlist/delete', { id: ids[4] }, env, { token: bob });
const [stL] = await post('/playlist/delete', { id: ids[4] }, env, { token: alice });
const [stM, gone] = await get('/playlist?id=' + ids[4], env);
const [, lib3] = await get('/playlists/mine', env, { token: alice });
const [stN] = await post('/playlist/save', { edit: ids[4], items: ID1 }, env, { token: alice });
const [stO] = await post('/playlist/rename', { id: ids[4], labels }, env, { token: alice });
const [stP] = await get('/playlist/history?id=' + ids[4], env);
check(stK === 403 && stL === 200 && stM === 410 && gone.deleted && !lib3.playlists.some(p => p.id === ids[4]) && stN === 410 && stO === 410 && stP === 410,
  'deleting: its link says it was deleted, it leaves your playlists, and it can\'t be edited or renamed');
const [, again] = await post('/playlist/suggest', { items: `${ID3}$10` }, env, { token: alice });
check(!again.saved && again.id !== ids[4], 'saving the same songs again makes a new playlist, not the deleted one');
const [stQ, back] = await post('/playlist/restore', { id: ids[4] }, env, { token: alice });
const [stR] = await get('/playlist?id=' + ids[4], env);
check(stQ === 200 && back.id === ids[4] && !back.pinned && stR === 200, 'restoring brings it back under the same ID (off the featured shelf)');

console.log('\n### Liner notes');
const [stS, n1] = await post('/playlist/save', { items: `${ID2},${ID3}$5-9`, labels, notes: ['  listen for\nthe bass ', ''] }, env, { token: alice });
const [, n1pub] = await get('/playlist?id=' + n1.id, env);
check(stS === 200 && JSON.stringify(n1pub.notes) === '["listen for the bass",""]', `notes are saved per song, tidied: ${JSON.stringify(n1pub.notes)}`);
const [stT] = await post('/playlist/save', { edit: n1.id, items: `${ID2},${ID3}$5-9`, notes: ['one'] }, env, { token: alice });
const [stU, long] = await post('/playlist/save', { edit: n1.id, items: `${ID2},${ID3}$5-9`, notes: ['', 'x'.repeat(141)] }, env, { token: alice });
const [stV, rude] = await post('/playlist/save', { edit: n1.id, items: `${ID2},${ID3}$5-9`, notes: ['what the fuck', ''] }, env, { token: alice });
check(stT === 400 && stU === 400 && long.note === 1 && stV === 400 && rude.note === 0, `one note per song, ${long.error.toLowerCase().replace(/^note 2 /, '')}, and "${rude.error}"`);
const [, n2] = await post('/playlist/save', { edit: n1.id, items: `${ID3}$5-9,${ID2}`, notes: ['', 'bass drop'] }, env, { token: alice });
check(JSON.stringify(n2.notes) === '["","bass drop"]', 'moving songs sends their notes along');
const [, n3] = await post('/playlist/save', { edit: n1.id, items: `${ID3}$5-9,${ID2},${ID1}` }, env, { token: alice });
const [, n4] = await post('/playlist/save', { edit: n1.id, items: `${ID3}$5-9,${ID2},${ID1}`, notes: ['x', '', ''] }, env, { token: alice });
const [, n5] = await post('/playlist/save', { edit: n1.id, items: `${ID3}$5-9,${ID2},${ID1}`, notes: ['', '', ''] }, env, { token: alice });
check(n3.notes === undefined && JSON.stringify(n4.notes) === '["x","",""]' && n5.notes === undefined && !all(env, 'SELECT * FROM liner_notes WHERE list = ?', n1.id).length,
  'changing songs without sending notes drops them; all-empty notes are removed');
const [, snap] = await post('/playlist/save', { items: `${ID1}$1-2`, labels, notes: ['mine'] }, env, { ip: '9.9.9.9' });
const [, snapPub] = await get('/playlist?id=' + snap.id, env);
check(!snap.owned && snapPub.notes === undefined, 'a snapshot (saved signed out) has no liner notes');

console.log('\n### Codes you named');
const [, sug] = await post('/suggest', { type: 'track', id: ID1 }, env);
const [stW] = await post('/claim', { type: 'track', id: ID1, zh: { code: sug.zh.code, chars: sug.zh.chars, why: sug.zh.why } }, env, { token: alice, ip: '1.1.1.1' });
const [, sug2] = await post('/suggest', { type: 'track', id: ID2 }, env);
await post('/claim', { type: 'track', id: ID2, em: { code: sug2.em.code, why: sug2.em.why } }, env, { ip: '3.3.3.3' });
const [, mineA] = await get('/codes/mine', env, { token: alice });
const [, mineB] = await get('/codes/mine', env, { token: bob });
const [stX] = await get('/codes/mine', env);
check(stW === 200 && mineA.codes.length === 1 && mineA.codes[0].code === sug.zh.code && mineA.codes[0].track === ID1 && mineA.codes[0].chars.length === 2 && mineB.codes.length === 0 && stX === 401,
  `a code saved while signed in shows in your collection (${mineA.codes.map(c => c.code)}); one saved signed out belongs to nobody's`);

console.log('\n### The sign and emoji sets, for pickers');
const [stY, sets, hdr] = await get('/sets', env);
check(stY === 200 && sets.glyphs.length === 98 && sets.glyphs[0].c && sets.glyphs[0].name && sets.emoji.length === 434 && sets.emoji.some(x => x.toneable) && /max-age=86400/.test(hdr.get('cache-control')),
  `${sets.glyphs.length} signs and ${sets.emoji.length} emoji, cached for a day`);
T.done();
