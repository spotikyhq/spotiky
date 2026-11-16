// Runs setup.mjs against a pretend Cloudflare account (bin/npx) and a pretend live Worker.
//   node run.mjs /path/to/repo
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.argv[2];
const HERE = dirname(fileURLToPath(import.meta.url));
chmodSync(join(HERE, 'bin', 'npx'), 0o755);
chmodSync(join(HERE, 'bin', 'google-chrome'), 0o755);
let pass = 0, fail = 0;
const check = (ok, what) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); };

const base = mkdtempSync(join(tmpdir(), 'spotiky-setup-'));
const home = join(base, 'home'); mkdirSync(home);
const work = join(base, 'repo'); mkdirSync(work);
for (const f of ['wrangler.jsonc', 'preview-worker.js', 'setup.mjs']) copyFileSync(join(REPO, f), join(work, f));
const STATE = join(base, 'state.json');
const CHROME_LOG = join(base, 'chrome.log');
const readState = () => JSON.parse(readFileSync(STATE, 'utf8'));
const writeState = s => writeFileSync(STATE, JSON.stringify(s, null, 2));
writeState({ loggedIn: false, dbs: [{ uuid: '11111111-2222-4333-8444-555555555555', name: 'other-db' }], secrets: {}, calls: [] });

// The pretend live Worker answers from the pretend account
const server = createServer((req, res) => {
  const s = readState();
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url.startsWith('/codes')) return s.deploys ? send(200, { '夜光': null }) : send(503, { error: 'Codes aren\'t set up' });
  if (req.url === '/auth/start' && req.method === 'POST') {
    return s.deploys && s.secrets.PEPPER && s.secrets.RESEND_API_KEY ? send(400, { error: 'Enter a valid email address' }) : send(503, { error: 'Sign-in isn\'t set up' });
  }
  send(404, {});
});
await new Promise(r => server.listen(0, r));
const workerUrl = `http://127.0.0.1:${server.address().port}`;

function setup({ args = [], env = {}, input = '' } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['setup.mjs', ...args], {
      cwd: work,
      env: { PATH: `${join(HERE, 'bin')}:${process.env.PATH}`, HOME: home, USERPROFILE: home, FAKE_STATE: STATE, FAKE_CHROME_LOG: CHROME_LOG, SPOTIKY_WORKER_URL: workerUrl, ...env },
    });
    let out = '';
    child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
    child.stdin.end(input);
    child.on('close', code => resolve({ code, out }));
  });
}
const backup = join(home, 'spotiky-PEPPER-backup.txt');
const configId = () => (readFileSync(join(work, 'wrangler.jsonc'), 'utf8').match(/"database_id"\s*:\s*"([^"]*)"/) || [])[1];

console.log('### First run: not signed in, no database, no secrets');
let r = await setup({ env: { RESEND_API_KEY: 're_first_key' } });
let s = readState();
check(r.code === 0, `finishes (exit ${r.code})`);
check(s.calls.includes('login') && s.loggedIn, 'signs in through the browser');
check(s.calls.includes('d1 create spotiky') && configId() === '7c1d0f8e-0b5a-4e6f-9a1b-2c3d4e5f6a7b', `makes the database and writes its ID into wrangler.jsonc (${configId()})`);
check(s.deploys === 1 && s.deployedWith === configId(), 'deploys with that database');
const pepper = s.secrets.PEPPER;
check(/^[A-Za-z0-9_-]{43}$/.test(pepper || ''), 'makes a PEPPER: 32 random bytes');
check(existsSync(backup) && readFileSync(backup, 'utf8').includes(`PEPPER=${pepper}\n`) && (statSync(backup).mode & 0o777) === 0o600, 'keeps a copy in the home folder, readable only by you');
check(!readFileSync(join(work, 'wrangler.jsonc'), 'utf8').includes(pepper) && !r.out.includes(pepper), 'the PEPPER is never written to the repo folder or printed');
check(s.secrets.RESEND_API_KEY === 're_first_key', 'sets the Resend key');
check(/✓ Codes and playlists work/.test(r.out) && /✓ Sign-in is ready/.test(r.out), 'live checks pass');

console.log('\n### Second run: everything is already there');
s.calls = []; writeState(s);
r = await setup();
s = readState();
check(r.code === 0 && !s.calls.includes('login') && !s.calls.some(c => c.startsWith('d1 create')), `no new sign-in, no new database (calls: ${s.calls.join(' | ')})`);
check(!s.calls.some(c => c.startsWith('secret put')) && s.secrets.PEPPER === pepper, 'secrets left alone: the PEPPER is unchanged');
check(/PEPPER is set, and stays as it is/.test(r.out) && /RESEND_API_KEY is set/.test(r.out), 'says so');

console.log('\n### The Worker lost its PEPPER, but the backup is here');
delete s.secrets.PEPPER; s.calls = []; writeState(s);
r = await setup();
s = readState();
check(r.code === 0 && s.secrets.PEPPER === pepper && /PEPPER put back from/.test(r.out), 'puts the same PEPPER back from the backup');

console.log('\n### No Resend key yet: typed in, or skipped');
delete s.secrets.RESEND_API_KEY; writeState(s);
r = await setup({ input: '\n' });
s = readState();
check(r.code === 0 && !('RESEND_API_KEY' in s.secrets) && /Skipped: sign-in stays off/.test(r.out) && /✗ Sign-in isn't ready yet \(no Resend key\)/.test(r.out), 'Enter skips it, and the check says sign-in is off');
r = await setup({ input: 're_typed_key\n' });
s = readState();
check(r.code === 0 && s.secrets.RESEND_API_KEY === 're_typed_key' && !r.out.includes('re_typed_key'), 'a pasted key is set and never echoed');
r = await setup({ args: ['--new-resend-key'], env: { RESEND_API_KEY: 're_new_key' } });
s = readState();
check(r.code === 0 && s.secrets.RESEND_API_KEY === 're_new_key', '--new-resend-key replaces it');

console.log('\n### Signing in through a Chrome profile instead of the default browser');
mkdirSync(join(home, '.config', 'google-chrome'), { recursive: true });
writeFileSync(join(home, '.config', 'google-chrome', 'Local State'), JSON.stringify({ profile: { info_cache: { 'Default': { name: 'Umar' }, 'Profile 1': { name: 'Work' } } } }));
const LINK = 'https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=54d11594&redirect_uri=http%3A%2F%2Flocalhost%3A8976%2Foauth%2Fcallback&scope=account%3Aread%20offline_access&state=Zx9&code_challenge=abc&code_challenge_method=S256';
const chromeOpens = () => existsSync(CHROME_LOG) ? readFileSync(CHROME_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const signedOut = () => { const st = readState(); st.loggedIn = false; st.calls = []; writeState(st); writeFileSync(CHROME_LOG, ''); };
for (const [asked, folder] of [['Work', 'Profile 1'], ['work', 'Profile 1'], ['Profile 1', 'Profile 1'], ['Umar', 'Default']]) {
  signedOut();
  r = await setup({ args: ['--chrome-profile', asked] });
  await new Promise(res => setTimeout(res, 200));
  s = readState();
  const opens = chromeOpens();
  check(r.code === 0 && s.calls.includes('login --browser=false') && s.loggedIn && opens.length === 1 && opens[0][0] === `--profile-directory=${folder}` && opens[0][1] === LINK,
    `--chrome-profile ${asked}: the sign-in link opens in Chrome's "${folder}" folder, whole (${JSON.stringify(opens[0] || null).slice(0, 60)}…)`);
}
signedOut();
r = await setup({ args: ['--chrome-profile=Work'] });
await new Promise(res => setTimeout(res, 200));
check(r.code === 0 && chromeOpens().length === 1 && chromeOpens()[0][0] === '--profile-directory=Profile 1', '--chrome-profile=Work works too');
signedOut();
r = await setup({ args: ['--chrome-profile', 'School'] });
await new Promise(res => setTimeout(res, 200));
check(r.code === 0 && chromeOpens().length === 0 && /no profile called "School"/.test(r.out) && /"Umar" \(Default\), "Work" \(Profile 1\)/.test(r.out) && readState().loggedIn,
  'a profile that doesn\'t exist: lists the real ones, and the printed link still works');
signedOut();
r = await setup({ args: ['--no-browser'] });
await new Promise(res => setTimeout(res, 200));
check(r.code === 0 && r.out.includes(LINK) && /Open that link in the browser you want/.test(r.out) && chromeOpens().length === 0 && readState().loggedIn, '--no-browser prints the link to open anywhere');
signedOut();
r = await setup({ args: [] });
check(r.code === 0 && readState().calls.includes('login') && /--chrome-profile "Work"/.test(r.out), 'without either, the default browser opens, with a hint about Chrome profiles');
r = await setup({ args: ['--chrome-profile'] });
check(r.code === 1 && /Say which Chrome profile/.test(r.out), '--chrome-profile with no name: says how to use it');

console.log('\n### --connect: opening the Builds settings to deploy from GitHub');
{
  const st = readState(); st.calls = []; st.loggedIn = true; const deploysBefore = st.deploys; writeState(st); writeFileSync(CHROME_LOG, '');
  r = await setup({ args: ['--connect', '--chrome-profile', 'Work'] });
  await new Promise(res => setTimeout(res, 200));
  const opened = existsSync(CHROME_LOG) ? readFileSync(CHROME_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const after = readState();
  check(r.code === 0 && opened.length === 1 && opened[0][1] === 'https://dash.cloudflare.com/acc1/workers/services/view/spotiky-preview/production/settings'
    && /Deploy command: npx wrangler deploy/.test(r.out) && after.deploys === deploysBefore && !after.calls.some(c => c.startsWith('d1') || c.startsWith('secret')),
    `--connect opens the Worker's settings in the Chrome profile, says what to pick, and changes nothing (${opened[0] && opened[0][1].slice(0, 60)}…)`);
  r = await setup({ args: ['--connect'] });
  check(r.code === 0 && /Open: https:\/\/dash\.cloudflare\.com\/acc1\/workers\/services\/view\/spotiky-preview\/production\/settings/.test(r.out), 'without a profile it prints the page to open');
}

console.log('\n### Problems it explains');
s = readState(); s.npmBroken = true; writeState(s);
r = await setup();
check(r.code === 1 && /npm error network aborted/.test(r.out) && /Wrangler didn't start/.test(r.out), 'when Wrangler can\'t be downloaded, the error shows instead of a silent wait');
s = readState(); s.npmBroken = false; writeState(s);
r = await setup();
check(r.code === 0 && /Getting Wrangler/.test(r.out) && /wrangler 4\.159\.0/.test(r.out), 'the download step shows its progress');
s.manyAccounts = true; writeState(s);
r = await setup();
check(r.code === 1 && /more than one account/.test(r.out) && /"account_id"/.test(r.out), 'several Cloudflare accounts: says to add account_id');
s.manyAccounts = false; writeState(s);
const elsewhere = join(base, 'empty'); mkdirSync(elsewhere); copyFileSync(join(work, 'setup.mjs'), join(elsewhere, 'setup.mjs'));
const wrong = spawnSync(process.execPath, ['setup.mjs'], { cwd: elsewhere, encoding: 'utf8', env: { ...process.env, HOME: home } });
check(wrong.status === 1 && /Run this in the folder that has preview-worker.js/.test(wrong.stderr), 'run in the wrong folder: says where to run it');

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
