// Playlist IDs: always a digit, and no rude words, also when spelled with numbers.
// Pulls the ID rules straight out of the built Worker and runs them here.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { T } from './fakes.mjs';
const check = T.check.bind(T);

const src = readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8');
const grab = re => { const m = src.match(re); if (!m) throw new Error('not found: ' + re); return m[0]; };
const code = [
  grab(/^const ID_ALPHABET = .*$/m),
  grab(/^const PLAYLIST_ID_RE = .*$/m),
  grab(/^const ID_BLOCK = \[[\s\S]*?\];$/m),
  grab(/^const LEET = .*$/m),
  grab(/^const ID_BLOCK_RE = .*$/m),
  grab(/^const rude = .*$/m),
  grab(/^function withDigit\(id\) \{[\s\S]*?\n\}$/m),
  'this.out = { ID_ALPHABET, PLAYLIST_ID_RE, rude, withDigit };',
].join('\n');
const box = {};
vm.runInNewContext(code, box);
const { ID_ALPHABET: A, PLAYLIST_ID_RE, rude, withDigit } = box.out;

console.log('### Every ID has a digit');
check(withDigit('k7f') === 'k7f' && /^[a-z]{2}[0-9]$/.test(withDigit('abc')) && withDigit('abc') === withDigit('abc'),
  `an all-letter start gets its last letter turned into a digit, the same one every time: abc -> ${withDigit('abc')}, k7f stays`);
check(PLAYLIST_ID_RE.test('5mh') && PLAYLIST_ID_RE.test('zzz9') && !PLAYLIST_ID_RE.test('abc') && !PLAYLIST_ID_RE.test('pax') && !PLAYLIST_ID_RE.test('il0') && !PLAYLIST_ID_RE.test('ab'),
  'IDs: 5mh, zzz9 yes; abc and pax (no digit), il0 (letters IDs never use), ab (too short) no');

console.log('\n### Rude words, also spelled with numbers');
const rudeOnes = ['a55', '455', 'sex', 's3x', '5h1t', 'sh17', 'b00b', '8008', '58008', 'c0ck', 'k0ck', 'fvck', 'phvck', 'd1ck', 'cvnt', 'n1g', 'n19', 'r4pe', 'rap3', 'p3n15', 'pen15', 'kkk', '1488', 'wh0r3', 'h03', 'p0rn', 'ped0', 'kys', 'f4g', 'naz1', 'ch1nk', 'sp1c', 'tw4t', 'w4nk', 'j1zz', 't1t', 'r3t4rd', 'tr4nny', 'dyk3'];
const missed = rudeOnes.filter(id => !rude(id));
check(!missed.length, `${rudeOnes.length} rude IDs blocked, e.g. a55 5h1t 8008 c0ck fvck p3n15${missed.length ? '; MISSED: ' + missed.join(' ') : ''}`);
const fine = ['k7f', 'v62', '5mh', 'zzz9', '3tb', 'q8m', 'w2x', 'x9z', 'm4p', 'b7y'];
const wrong = fine.filter(rude);
check(!wrong.length, `ordinary IDs pass: ${fine.join(' ')}${wrong.length ? '; WRONGLY BLOCKED: ' + wrong.join(' ') : ''}`);

console.log('\n### How many 3-character IDs are left');
let withDigitCount = 0, usable = 0;
for (const a of A) for (const b of A) for (const c of A) {
  const id = a + b + c;
  if (!/[0-9]/.test(id)) continue;
  withDigitCount++;
  if (!rude(id)) usable++;
}
check(withDigitCount === 22120, `3-character IDs with a digit: ${withDigitCount} of ${32 ** 3}`);
check(usable > 21500, `after the blocklist: ${usable} (${withDigitCount - usable} blocked)`);
let fourUsable = 0;
for (const a of A) for (const b of A) for (const c of A) for (const d of A) {
  const id = a + b + c + d;
  if (/[0-9]/.test(id) && !rude(id)) fourUsable++;
}
console.log(`  (4-character IDs left: ${fourUsable})`);
T.done();
