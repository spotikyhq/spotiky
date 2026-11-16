// Browser tests for the collection page, the label editor, liner notes and drafts, with the page
// talking to the real Worker code (worker/worker.mjs) over a stand-in database, AI, email and Spotify.
//   NODE_PATH=$(npm root -g) node e2e_collection.mjs /path/to/repo [shots-folder]
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ID1, ID2, ID3, resend, goodAnswer, fakeAI, newEnv, post, get, one, all, worker } from './worker/fakes.mjs';
const require = createRequire(path.join(process.env.NODE_PATH || '.', 'x.js'));
const { chromium } = require('playwright');

const ROOT = process.argv[2], SHOTS = process.argv[3];
const WORKER = 'https://spotiky-preview.spotikyhq.workers.dev';
const SECRETS = { PEPPER: 'a-long-random-pepper-for-tests-0123456789abcdef', RESEND_API_KEY: 're_test_key' };
const lastCode = () => (resend.sent[resend.sent.length - 1].text.match(/\b(\d{6})\b/) || [])[1];
let pass = 0, fail = 0; const errors = [];
const check = (ok, line) => { ok ? pass++ : fail++; console.log((ok ? 'ok   ' : 'FAIL ') + line); };
const wait = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split(/[?#]/)[0]);
  const fp = path.join(ROOT, p === '/' ? 'index.html' : p.slice(1));
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    res.writeHead(200, { 'Content-Type': /\.js$/.test(fp) ? 'application/javascript' : 'text/html' });
    return res.end(fs.readFileSync(fp));
  }
  res.writeHead(404, { 'Content-Type': 'text/html' });
  res.end(fs.readFileSync(path.join(ROOT, '404.html')));
});
const FAKE_API = `(function(){window.__calls=[];const ctrl={loadEntity(u,v,a){window.__calls.push({load:u.split(':').pop(),at:a});},play(){},pause(){},addListener(){}};
(function w(){if(!window.onSpotifyIframeApiReady)return setTimeout(w,10);window.onSpotifyIframeApiReady({createController(e,o,cb){cb(ctrl);}});})();})();`;

const ai = fakeAI([goodAnswer]);
const env = await newEnv({ ...SECRETS, AI: ai });
async function signIn(email) {
  await post('/auth/start', { email }, env, { ip: '7.7.7.7' });
  const [, b] = await post('/auth/verify', { email, code: lastCode() }, env);
  return b.token;
}
const alice = await signIn('alice@example.com');
const row = id => one(env, 'SELECT * FROM playlists WHERE id = ?', id);

// Alice's collection to start with: five playlists (one she named herself) and a code she named
const [, sug] = await post('/playlist/suggest', { items: `${ID1}$4-8,${ID2}` }, env, { token: alice });
const base4 = { zh: sug.labels.zh, eg: sug.labels.eg, em: sug.labels.em };
const made = [];
for (const [items, en, typed, notes] of [
  [`${ID1}$4-8,${ID2}`, 'night-run', ['en'], undefined],
  [`${ID3}`, 'dream-state', [], ['the guitar at 0:30']],
  [`${ID2}$10-20`, 'ocean', [], undefined],
  [`${ID1},${ID3}`, 'two-step', [], undefined],
  [`${ID3}$5`, 'last-one', [], undefined],
]) {
  const [st, p] = await post('/playlist/save', { items, labels: { ...base4, en: { code: en }, typed }, notes }, env, { token: alice });
  if (st !== 200) throw new Error('seed failed ' + JSON.stringify(p));
  made.push(p);
}
const [P1, P2, , , P5] = made;
const [, csug] = await post('/suggest', { type: 'track', id: ID1 }, env);
await post('/claim', { type: 'track', id: ID1, zh: { code: csug.zh.code, chars: csug.zh.chars, why: csug.zh.why } }, env, { token: alice, ip: '7.7.7.7' });
const CODE = csug.zh.code;

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const newCtx = async ({ token, viewport } = {}) => {
    const ctx = await browser.newContext(viewport ? { viewport, deviceScaleFactor: 2 } : { viewport: { width: 1200, height: 900 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    if (token) await ctx.addInitScript(t => { if (!sessionStorage.getItem('signedOut')) localStorage.setItem('spotiky-session', JSON.stringify({ token: t, expires: Date.now() + 864e5 })); }, token);
    await ctx.route('**/*', async route => {
      const req = route.request(), u = req.url();
      if (u.startsWith('https://open.spotify.com/embed/iframe-api')) return route.fulfill({ contentType: 'application/javascript', body: FAKE_API });
      if (u.startsWith('https://fonts.googleapis.com/css2')) {
        return route.fulfill({ contentType: 'text/css', body: `@font-face { font-family: "Noto Sans Egyptian Hieroglyphs"; src: url(${base}/dev/fonts/hieroglyphs.woff2) format("woff2"); }` });
      }
      if (u.startsWith('https://fonts.')) return route.fulfill({ status: 404, body: '' });
      if (u.startsWith(base)) return route.continue();
      if (u.startsWith(WORKER)) {
        const method = req.method();
        const r = await worker.fetch(new Request(u.replace(WORKER, 'https://w.dev'), { method, headers: req.headers(), body: ['GET', 'HEAD', 'OPTIONS'].includes(method) ? undefined : req.postData() }), env);
        return route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: Buffer.from(await r.arrayBuffer()) });
      }
      return route.fulfill({ status: 404, body: '' });
    });
    return ctx;
  };
  const open = async (ctx, p) => {
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + p);
    return page;
  };
  const text = (page, sel) => page.textContent(sel).then(t => (t || '').replace(/\s+/g, ' ').trim());
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false }); };
  // Waits for the toast that says what's expected (an earlier one can still be showing)
  const toastText = (page, re) => page.waitForFunction(src => [...document.querySelectorAll('.col-toast')].some(x => new RegExp(src).test(x.textContent)), re.source, { timeout: 5000 })
    .then(() => page.textContent('.col-toast'), () => page.textContent('.col-toast').catch(() => ''));

  console.log('### The collection page');
  {
    const ctx = await newCtx({ token: alice });
    const page = await open(ctx, '/account');
    await page.waitForSelector('#colList .tile', { timeout: 8000 });
    await wait(300);
    const tabs = await page.$$eval('.col-tabs [role=tab]', ts => ts.map(t => t.textContent.trim()));
    check(tabs.join(' | ') === 'Playlists5 | Codes you named1 | Clips6', `tabs with counts: ${tabs.join(' | ')}`);
    check(await page.isHidden('#accountPanel') && await page.isHidden('#trackView') && /wide/.test(await page.getAttribute('body', 'class')), 'the page is the collection; no sign-in panel, no song box');
    const caps = await page.$$eval('#colList .tile .cap', cs => cs.map(c => c.textContent));
    check(caps.length === 5 && caps.includes('“night-run”') && caps.filter(c => c === '🌃💡').length === 4, `sleeves: a name you typed shows in quotes, the rest by their emoji (${caps.join(' ')})`);
    const glyph = await page.$eval(`#colList .tile[data-id="${P1.id}"] .glyph`, g => g.textContent);
    check(glyph === 'night run', `the sleeve's record label carries the typed name: "${glyph}"`);
    check(/Pin up to 4 playlists here/.test(await text(page, '.shelf')), 'the featured shelf starts empty, saying how to fill it');
    await page.fill('.col-tools input[type=search]', 'night');
    await wait(100);
    check((await page.$$('#colList .tile')).length === 1, 'search finds playlists by any of their labels');
    await page.fill('.col-tools input[type=search]', P2.id);
    await wait(100);
    check((await page.$$eval('#colList .tile', ts => ts.map(t => t.dataset.id))).join() === P2.id, '…and by ID');
    await page.fill('.col-tools input[type=search]', 'zzzz');
    await wait(100);
    check(/Nothing matches “zzzz”/.test(await text(page, '#colList')), 'no match says so');
    await page.fill('.col-tools input[type=search]', '');
    await page.selectOption('.col-tools select', 'songs');
    await wait(100);
    const first = await page.$eval('#colList .tile', t => t.dataset.id);
    check([P1.id, made[3].id].includes(first), 'sorting by most songs puts a 2-song playlist first');
    await page.click('.col-layout button >> text=List');
    await wait(100);
    check(await page.isVisible('.sleeves.list') && await page.evaluate(() => localStorage.getItem('spotiky-collection-layout')) === 'list', 'the list layout is remembered in this browser');
    await page.click('.col-layout button >> text=Sleeves');
    await shot(page, 'collection-laptop');

    console.log('\n### One playlist up close');
    await page.click(`#colList .tile[data-id="${P1.id}"]`);
    await page.waitForSelector('.col-sheet .names');
    await wait(500);
    const sheet = await text(page, '.col-sheet');
    check(/“night-run”/.test(await text(page, '.col-sheet h2')) && /English\s*“night-run”\s*Named by you/.test(sheet), 'the sheet leads with the name you typed, marked as yours');
    check(/Blinding Lights/.test(await text(page, '.col-sheet .songs')) && /0:04–0:08/.test(sheet) && /Made as/.test(await text(page, '.col-sheet .trail')), `songs with names and clip times, and its history: "${await text(page, '.col-sheet .trail')}"`);
    check((await text(page, '.col-sheet .link-line code')) === `spotiky.com/playlist/${P1.id}-night-run`, 'its link uses the name you typed');
    await page.click('.col-sheet .act >> text=Copy link');
    await wait(150);
    check(decodeURIComponent(await page.evaluate(() => navigator.clipboard.readText())) === `https://spotiky.com/playlist/${P1.id}-night-run`, 'Copy link copies it');
    await shot(page, 'sheet-laptop');
    await page.click('.col-sheet .act >> text=Pin');
    check(/Pinned to Featured/.test(await toastText(page, /Pinned/)) && /Unpin/.test(await text(page, '.col-sheet .sheet-acts')), 'Pin puts it on the featured shelf');
    await page.click('.col-sheet .act >> text=Put in a crate');
    await page.click('.menu >> text=New crate…');
    await page.fill('.crate-new input', 'Late night');
    await page.click('.crate-new button');
    check(/Moved to Late night/.test(await toastText(page, /Moved/)) && row(P1.id) && one(env, 'SELECT crate FROM shelf WHERE id = ?', P1.id).crate === 'Late night', 'a new crate, saved');

    console.log('\n### Renaming with the label editor');
    await page.click('.col-sheet .act >> text=/Rename/');
    await page.waitForSelector('.col-sheet .ed-row');
    check(/3 of 3 renames left today/.test(await text(page, '.ed-foot')) && /yours/.test(await text(page, '.ed-row[data-kind="en"] .ed-head')), 'the editor shows renames left, and which label is yours');
    await page.fill('.ed-row[data-kind="zh"] input', '月光');
    await wait(100);
    const prompt = await text(page, '.ed-match');
    check(/You changed Chinese. Match Hieroglyphs, Emoji to your new name too\?/.test(prompt) && /yours/.test(await text(page, '.ed-row[data-kind="zh"] .ed-head')),
      `changing one label offers to match the others, and leaves your English name alone: "${prompt.slice(0, 70)}…"`);
    await page.click('.ed-match button >> text=Match the others');
    await page.waitForSelector('.ed-row[data-kind="em"] .badge.matched', { timeout: 5000 });
    const emBefore = await page.inputValue('.ed-row[data-kind="em"] input');
    const dice = await page.$('.ed-row[data-kind="em"] button[aria-label^="Another"]');
    if (dice) await dice.click();
    const emAfter = await page.inputValue('.ed-row[data-kind="em"] input');
    check(/matched/.test(await text(page, '.ed-row[data-kind="eg"] .ed-head')) && dice && emAfter !== emBefore, `matched labels can be rerolled: ${emBefore} → ${emAfter}`);
    await shot(page, 'editor-laptop');
    await page.click('.ed-foot button >> text=Save names');
    check(/Renamed/.test(await toastText(page, /Renamed/)), 'Save names renames it');
    const saved = JSON.parse(row(P1.id).labels);
    check(saved.zh.code === '月光' && saved.em.code === emAfter && saved.en.code === 'night-run' && JSON.stringify(saved._typed) === '["zh","en"]',
      `saved: ${saved.zh.code} ${saved.eg.code} ${saved.em.code} ${saved.en.code}, typed ${saved._typed}`);
    await wait(300);
    check(/Rename \(2 left today\)/.test(await text(page, '.col-sheet .sheet-acts')) && /Chinese\s*“月光”\s*Named by you/.test(await text(page, '.col-sheet .names')), 'the sheet shows the new name and 2 renames left');
    await page.click('.col-sheet .sheet-close');
    await wait(200);
    check((await page.$$eval('.shelf .tile', ts => ts.map(t => t.dataset.id))).join() === P1.id && /Late night/.test(await text(page, '.crates')), 'it stands on the featured shelf, and the crate appears as a filter');
    await page.click('.crates button >> text=Late night');
    await wait(100);
    check((await page.$$eval('#colList .tile', ts => ts.map(t => t.dataset.id))).join() === P1.id, 'the crate filter shows just what is in it');
    await page.click('.crates button >> text=All');

    console.log('\n### Deleting, with undo');
    await page.click(`#colList .tile[data-id="${P5.id}"]`);
    await page.waitForSelector('.col-sheet .names');
    await page.click('.col-sheet .act >> text=Delete');
    const t1 = await toastText(page, /Deleted/);
    check(/Deleted .* links stop working/.test(t1) && !(await page.$(`#colList .tile[data-id="${P5.id}"]`)) && one(env, 'SELECT deleted FROM shelf WHERE id = ?', P5.id).deleted, `Delete takes it out: "${t1}"`);
    await page.click('.col-toast button >> text=Undo');
    await page.waitForSelector(`#colList .tile[data-id="${P5.id}"]`, { timeout: 4000 }).catch(() => {});
    check(!!(await page.$(`#colList .tile[data-id="${P5.id}"]`)) && !one(env, 'SELECT deleted FROM shelf WHERE id = ?', P5.id).deleted, 'Undo brings it back');

    console.log('\n### Codes you named, and clips');
    await page.click('.col-tabs [role=tab] >> text=Codes you named');
    await page.waitForSelector('.item-row');
    await wait(400);
    check((await text(page, '.item-row')).includes(CODE) && /Blinding Lights/.test(await text(page, '.item-row')) && await page.getAttribute('.item-row a.go', 'href') === `/${CODE}`,
      `the code you named, its song, and Play: ${CODE}`);
    await page.click('.item-row .act >> text=Add to playlist');
    await page.click(`.menu >> text=/${P2.id}/`);
    const t2 = await toastText(page, /Added to/);
    check(/Added to/.test(t2) && row(P2.id).items === `${ID3},${CODE}` && JSON.stringify(JSON.parse(one(env, 'SELECT notes FROM liner_notes WHERE list = ?', P2.id).notes)) === '["the guitar at 0:30",""]',
      `Add to playlist saves it to that playlist, notes kept in line: ${row(P2.id).items}`);
    await page.click('.col-tabs [role=tab] >> text=Clips');
    await page.waitForSelector('.item-row');
    await wait(300);
    const clipRows = await page.$$eval('.item-row', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ')));
    check(clipRows.some(r => /0:04–0:08/.test(r) && /Blinding Lights/.test(r)) && (await page.$$eval('.item-row a.go', as => as.map(a => a.getAttribute('href')))).includes(`/track/${ID1}$4-8`),
      `clips from all your playlists, each playable: ${clipRows.length} of them`);
    await page.close();

    console.log('\n### On a phone');
    const phone = await newCtx({ token: alice, viewport: { width: 390, height: 844 } });
    const pp = await open(phone, '/account');
    await pp.waitForSelector('#colList .tile', { timeout: 8000 });
    await wait(400);
    const wide = await pp.evaluate(() => document.documentElement.scrollWidth);
    const cols = await pp.$$eval('#colList .tile', ts => new Set(ts.map(t => Math.round(t.getBoundingClientRect().left))).size);
    check(wide <= 390 && cols === 2, `no sideways scrolling, sleeves two across (${wide}px wide, ${cols} columns)`);
    await shot(pp, 'collection-phone');
    await pp.click(`#colList .tile[data-id="${P1.id}"]`);
    await pp.waitForSelector('.col-sheet .names');
    await wait(300);
    const box = await pp.$eval('.col-sheet', s => { const r = s.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom }; });
    check(box.left === 0 && box.right === 390 && Math.round(box.bottom) === 844, 'the sheet comes up from the bottom, full width');
    await shot(pp, 'sheet-phone');
    await pp.keyboard.press('Escape');
    await wait(100);
    check(!(await pp.$('.col-sheet')), 'Escape closes it');
    await pp.close(); await phone.close(); await ctx.close();
  }

  console.log('\n### Liner notes and drafts on the playlist page');
  {
    const ctx = await newCtx({ token: alice });
    const page = await open(ctx, `/playlist/${P2.id}`);
    await page.waitForSelector('#rows .row textarea.note:not([hidden])', { timeout: 8000 });
    await wait(300);
    check(await page.isVisible('#renameListBtn') && (await page.inputValue('#rows .row:nth-child(1) textarea.note')) === 'the guitar at 0:30'
      && await page.isVisible('#rows .row:nth-child(2) .add-note'), 'your playlist: Rename in the bar, its note in its box, "+ Liner note" on the others');
    await page.click('#rows .row:nth-child(2) .add-note');
    await page.fill('#rows .row:nth-child(2) textarea.note', 'wait for the drop');
    await wait(100);
    check(!(await page.isDisabled('#saveListBtn')), 'a new note turns Save changes on');
    await page.reload();
    await page.waitForSelector('#draftBar:not([hidden])', { timeout: 6000 }).catch(() => {});
    check(/You have unsaved changes to this playlist/.test(await text(page, '#draftBar')), 'leaving and coming back offers the unsaved changes');
    await page.click('#draftBar button >> text=Restore');
    await wait(200);
    check((await page.inputValue('#rows .row:nth-child(2) textarea.note')) === 'wait for the drop', 'Restore brings the note back');
    await shot(page, 'playlist-notes');
    await page.click('#saveListBtn');
    await wait(500);
    check(JSON.stringify(JSON.parse(one(env, 'SELECT notes FROM liner_notes WHERE list = ?', P2.id).notes)) === '["the guitar at 0:30","wait for the drop"]'
      && !(await page.evaluate(() => JSON.parse(localStorage.getItem('spotiky-drafts') || '{}')))[P2.id], 'Save changes saves the notes and clears the draft');
    await page.click('#playlistView button >> text=Play playlist');
    await wait(300);
    check((await text(page, '#linerNote')) === '♪ the guitar at 0:30', `playing a song shows its note: "${await text(page, '#linerNote')}"`);
    await page.close();
    const viewer = await newCtx();
    const vp = await open(viewer, `/playlist/${P2.id}`);
    await vp.waitForSelector('#rows .row .note-view:not([hidden])', { timeout: 8000 }).catch(() => {});
    check((await vp.$$eval('#rows .note-view:not([hidden])', ns => ns.map(n => n.textContent))).join(' | ') === '♪ the guitar at 0:30 | ♪ wait for the drop'
      && !(await vp.$('#rows textarea.note:not([hidden])')), 'anyone else reads the notes, and can\'t edit them');
    await vp.close();
    const gone = await open(viewer, `/playlist/${P2.id}#play`);
    await wait(1500);
    check((await gone.evaluate(() => window.__calls.length)) > 0, 'a link ending in #play starts playing once it opens');
    await gone.close();
    await post('/playlist/delete', { id: P5.id }, env, { token: alice });
    const del = await open(viewer, `/playlist/${P5.id}`);
    await wait(800);
    check(/Its owner deleted this playlist/.test(await text(del, '#status')), 'a deleted playlist\'s link says so');
    await del.close(); await viewer.close();

    const fresh = await open(ctx, '/playlist');
    await wait(400);
    await fresh.fill('#rows .row:last-child input', ID1);
    await wait(200);
    await fresh.goto(base + '/');
    await fresh.goto(base + '/playlist');
    await fresh.waitForSelector('#draftBar:not([hidden])', { timeout: 6000 }).catch(() => {});
    check(/Pick up where you left off\? 1 song from/.test(await text(fresh, '#draftBar')), 'the blank playlist maker offers back what you were making');
    await fresh.click('#draftBar button >> text=Restore');
    await wait(200);
    check((await fresh.inputValue('#rows .row:nth-child(1) input')) === ID1, '…and restores it');
    await fresh.close(); await ctx.close();
  }

  console.log('\n### Naming a new playlist yourself');
  {
    const ctx = await newCtx({ token: alice });
    const page = await open(ctx, `/playlist/${ID2},${ID3}$30`);
    await wait(500);
    await page.click('#playlistView button >> text=Share as a code');
    await page.waitForSelector('#sharePanel .code-card');
    await page.click('#sharePanel button >> text=Name it yourself');
    await page.waitForSelector('.col-sheet .ed-row');
    check(/Nothing is saved until you copy a link/.test(await text(page, '.ed-foot')), 'the editor opens on the share card, nothing saved yet');
    await page.fill('.ed-row[data-kind="en"] input', 'Rain Walk');
    await page.click('.ed-match button >> text=Match the others');
    await page.waitForSelector('.ed-row[data-kind="zh"] .badge.matched', { timeout: 5000 });
    await page.click('.ed-foot button >> text=Use these names');
    await wait(500);
    const cards = await page.$$eval('#sharePanel .code-card', cs => cs.map(c => c.dataset.script + ':' + c.querySelector('.copy-code').textContent));
    check(cards.some(c => /^en:Copy .*-rain-walk link$/.test(c)) && /yours/.test(await text(page, '#sharePanel .code-card[data-script="en"] .code-label')),
      `the share card takes the names, yours marked: ${cards.find(c => c.startsWith('en'))}`);
    await page.$eval('#sharePanel', e => e.scrollIntoView());
    await shot(page, 'share-named');
    await page.click('#sharePanel .code-card[data-script="en"] .copy-code');
    await wait(800);
    const id = decodeURIComponent(await page.evaluate(() => navigator.clipboard.readText())).match(/playlist\/([0-9a-z]+)-rain-walk$/);
    const stored = id && JSON.parse(row(id[1]).labels);
    check(id && stored.en.code === 'rain-walk' && JSON.stringify(stored._typed) === '["en"]' && row(id[1]).owner, `copying saves it to your account with your name on it: ${id && id[1]}-rain-walk`);
    await page.close(); await ctx.close();
  }

  console.log('\n### Signing in from the collection page');
  {
    const ctx = await newCtx();
    const page = await open(ctx, '/account');
    await page.waitForSelector('#signInEmail');
    await page.fill('#signInEmail', 'bob@example.com');
    await page.click('#accountPanel >> text=Email me a code');
    await page.waitForSelector('#signInCode');
    await page.fill('#signInCode', lastCode());
    await page.click('#accountPanel button >> text=Sign in');
    await page.waitForSelector('.col-tabs', { timeout: 8000 }).catch(() => {});
    check(await page.isHidden('#accountPanel') && /No playlists yet/.test(await text(page, '#collectionView')), 'signing in opens your (empty) collection right there');
    await page.click('#accountBtn');
    await page.click('#accountPanel >> text=Sign out');
    await wait(400);
    check(/Sign in to keep your playlists here/.test(await text(page, '#collectionView')), 'signing out goes back to the sign-in prompt');
    await page.close(); await ctx.close();
  }

  await browser.close();
  server.close();
  console.log(`\n${pass} passed, ${fail} failed${errors.length ? '; PAGE ERRORS: ' + [...new Set(errors)].join(' | ') : '; no page errors'}`);
  process.exit(fail || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
