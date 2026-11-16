// Browser tests for Spotiky code links (tracks + playlists).
// Serves the repo like GitHub Pages, swaps the Spotify IFrame API for a simulated player
// (position reported once a second), and fakes the Worker's /codes lookup with a small store.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = process.argv[2];
const ID1 = 'A'.repeat(21) + '1', ID2 = 'B'.repeat(21) + '2', ID3 = 'C'.repeat(21) + '3', ID4 = 'D'.repeat(21) + '4';
const KV = { '夜光': { type: 'track', id: ID1 }, '海眸': { type: 'track', id: ID2 }, '𓇰𓇶': { type: 'track', id: ID3 }, '🌃💡': { type: 'track', id: ID4 }, '💃🌃': { type: 'track', id: ID3 } };
// Saved playlists, by ID: an ID plus labels; the Worker answers GET /playlist?id=
const PLAYLISTS = { k7f: { id: 'k7f', items: `${ID1}$4-8,${ID2}`, mine: false, owned: false,
  labels: { zh: { code: '星心', chars: [{ char: '星', meaning: 'star' }, { char: '心', meaning: 'heart' }] }, en: { code: 'star-heart', chars: [{ char: 'star' }, { char: 'heart' }] } } } };
const NAMES = { [ID1]: 'Blinding Lights', [ID2]: 'Ocean Eyes', [ID3]: 'Midnight City', [ID4]: 'Dreams' };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split(/[?#]/)[0]);
  const fp = path.join(ROOT, p === '/' ? 'index.html' : p.slice(1));
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) { res.writeHead(200, { 'Content-Type': /\.js$/.test(fp) ? 'application/javascript' : 'text/html' }); return res.end(fs.readFileSync(fp)); }
  res.writeHead(404, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(ROOT, '404.html')));
});

const FAKE_API = `
(function () {
  window.__calls = [];
  let cur = null, listeners = [], last = performance.now();
  const live = () => cur ? cur.pos + (cur.playing ? performance.now() - last : 0) : 0;
  const emit = () => { if (!cur) return; const d = { playingURI: cur.uri, position: Math.round(cur.pos), duration: cur.dur, isPaused: !cur.playing, isBuffering: false }; listeners.forEach(fn => fn({ data: d })); };
  setInterval(() => { const now = performance.now(); if (cur && cur.playing) { cur.pos += now - last; if (cur.pos >= cur.dur) { cur.pos = cur.dur; cur.playing = false; } emit(); } last = now; }, 1000);
  const ctrl = {
    loadEntity(uri, v, at) { const id = uri.split(':').pop(); window.__calls.push({ load: id, at }); cur = { uri, dur: 300000, pos: (at || 0) * 1000, playing: false }; },
    play() { window.__calls.push({ play: true }); if (cur) { cur.pos = live(); cur.playing = true; last = performance.now(); emit(); } },
    pause() { const p = Math.round(live()); window.__calls.push({ pause: true, pos: p, id: cur && cur.uri.split(':').pop() }); if (cur) { cur.pos = p; cur.playing = false; last = performance.now(); emit(); } },
    addListener(ev, fn) { if (ev === 'playback_update') listeners.push(fn); },
  };
  (function wait() { if (!window.onSpotifyIframeApiReady) return setTimeout(wait, 10); window.onSpotifyIframeApiReady({ createController(el, o, cb) { cb(ctrl); } }); })();
})();`;

let pass = 0, fail = 0; const errors = [];
const check = (ok, line) => { ok ? pass++ : fail++; console.log((ok ? 'ok   ' : 'FAIL ') + line); };
const short = s => String(s).split(ID1).join('ID1').split(ID2).join('ID2').split(ID3).join('ID3').split(ID4).join('ID4');
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  let codeRequests = [], workerDown = false;
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('https://open.spotify.com/embed/iframe-api')) return route.fulfill({ contentType: 'application/javascript', body: FAKE_API });
    if (u.startsWith(base)) return route.continue();
    if (u.includes('spotiky-preview')) {
      const url = new URL(u);
      const cors = { 'Access-Control-Allow-Origin': '*' };
      if (url.pathname === '/codes') {
        const codes = url.searchParams.get('c').split(',');
        codeRequests.push(codes);
        if (workerDown) return route.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{"error":"boom"}' });
        return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(Object.fromEntries(codes.map(c => [c, KV[c] || null]))) });
      }
      if (url.pathname === '/playlist') {
        const pl = PLAYLISTS[url.searchParams.get('id')];
        return route.fulfill({ status: pl ? 200 : 404, contentType: 'application/json', headers: cors, body: JSON.stringify(pl || { error: 'No playlist has this link' }) });
      }
      return route.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify({ name: NAMES[url.searchParams.get('id')] || null, preview_url: null }) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  const open = async (p) => {
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + p);
    await page.waitForFunction(() => window.__calls !== undefined);
    return page;
  };
  const calls = page => page.evaluate(() => window.__calls);
  const loads = async page => (await calls(page)).filter(c => c.load).map(c => `${short(c.load)}@${c.at}`);
  const status = page => page.textContent('#status');
  const pathNow = page => page.evaluate(() => decodeURIComponent(location.pathname));
  const nonAscii = [];   // copied links go out as plain ASCII; tests compare them decoded
  const clip = async page => {
    const t = await page.evaluate(() => navigator.clipboard.readText());
    if (/[^\x00-\x7F]/.test(t)) nonAscii.push(t);
    try { return decodeURIComponent(t); } catch (e) { return t; }
  };

  console.log('\n### Track links with codes');
  {
    const page = await open('/track/夜光83-86');
    await wait(5600);
    const c = await calls(page), pause = c.find(x => x.pause);
    check((await loads(page))[0] === 'ID1@83', '/track/夜光83-86 (no $) looks up 夜光 and starts its song at 1:23');
    check(pause && Math.abs(pause.pos - 86000) < 300, `…and stops at 1:26 (${pause ? pause.pos - 86000 : '?'} ms off)`);
    check(await pathNow(page) === '/夜光83-86', `address bar keeps the code: ${await pathNow(page)}`);
    await page.click('#replayBtn'); await wait(400);
    check((await loads(page)).pop() === 'ID1@83' && await pathNow(page) === '/夜光83-86', 'Replay clip keeps the code link');
    await page.close();
  }
  for (const [p, want, label] of [
    ['/夜光.4-.6', 'ID1@4', 'root code with dot times'],
    ['/𓇰𓇶3.23-3.25', 'ID3@203', 'hieroglyph code with m.ss times'],
    ['/track/夜光$1.23', 'ID1@83', 'code with $ still works'],
    ['/海眸1:23', 'ID2@83', 'code with m:ss start only'],
    ['/' + encodeURIComponent('海眸') + '83', 'ID2@83', 'percent-encoded code'],
    ['/海眸', 'ID2@0', 'code alone plays from the start'],
    ['/🌃💡83', 'ID4@83', 'emoji code with seconds'],
    ['/track/🌃💡1:23-1:45', 'ID4@83', 'emoji code with a clip'],
    ['/🌃\uFE0F💡.83', 'ID4@83', 'emoji with a style marker (U+FE0F)'],
    ['/💃🏾🌃83', 'ID3@83', 'emoji code with a skin tone'],
    ['/track/💃🏿🌃1:23-1:45', 'ID3@83', 'another skin tone, same song'],
    ['/💃🌃83', 'ID3@83', 'and no skin tone'],
  ]) {
    const page = await open(p); await wait(1300);
    const l = (await loads(page))[0];
    check(l === want, `${label.padEnd(34)} ${decodeURIComponent(p).padEnd(16)} -> ${l || 'nothing'}`);
    await page.close();
  }
  {
    codeRequests = [];
    const page = await open('/💃🏽🌃1:23-1:25'); await wait(1300);
    check((await loads(page))[0] === 'ID3@83' && await pathNow(page) === '/💃🏽🌃83-85' && await page.inputValue('#link') === '💃🏽🌃',
      `the skin tone stays in the link and the link box: ${await pathNow(page)}`);
    check(codeRequests.flat().join() === '💃🌃', `…and the code is looked up without it: ${codeRequests.flat().join()}`);
    await page.click('text="Copy link"'); await wait(150);
    check(await clip(page) === 'https://spotiky.com/💃🏽🌃83-85', `copy link keeps the tone: ${await clip(page)}`);
    await page.close();
  }
  {
    const page = await open('/月光'); await wait(800);
    check(!(await loads(page)).length && await status(page) === 'No song has the code 月光 yet.', `unknown code: "${await status(page)}"`);
    await page.close();
    workerDown = true;
    const page2 = await open('/夜光'); await wait(800);
    check(!(await loads(page2)).length && /Couldn't look up that code/.test(await status(page2)), `Worker down: "${await status(page2)}"`);
    workerDown = false;
    await page2.close();
  }
  {
    const page = await open('/');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('ready'));
    await page.fill('#link', '夜光1:23-1:25');
    await page.click('text=Play from timestamp'); await wait(300);
    check((await loads(page))[0] === 'ID1@83', 'typing 夜光1:23-1:25 in the link box plays from 1:23');
    await page.click('text="Copy link"'); await wait(150);
    check(await clip(page) === 'https://spotiky.com/夜光83-85', `copy link -> ${await clip(page)}`);
    await page.fill('#link', 'https://spotiky.com/𓇰𓇶'); await page.fill('#time', '0:10'); await page.fill('#endTime', '0:12');
    await page.click('text="Copy link"'); await wait(150);
    check(await clip(page) === 'https://spotiky.com/𓇰𓇶10-12', `time boxes win over the link: ${await clip(page)}`);
    await page.fill('#link', `https://open.spotify.com/track/${ID4}`); await page.fill('#time', '83'); await page.fill('#endTime', '');
    await page.click('text="Copy link"'); await wait(150);
    check(await clip(page) === `https://open.spotiky.com/track/${ID4}$83`, 'Spotify links still copy the f→k link');
    await page.close();
  }

  console.log('\n### Playlist links with codes');
  {
    codeRequests = [];
    const page = await open('/playlist/夜光.4-.8,海眸1.23-4.05, 𓇰𓇶3.23-3.24');
    await wait(700);
    const vals = await page.$$eval('#rows input', els => els.map(e => e.value));
    const infos = await page.$$eval('#rows .info', els => els.map(e => e.textContent));
    check(vals.length === 4 && vals[3] === '', `your example opens as ${vals.length - 1} songs + an empty row`);
    check(infos[0] === 'Blinding Lights · 0:04–0:08' && infos[1] === 'Ocean Eyes · 1:23–4:05' && infos[2] === 'Midnight City · 3:23–3:24',
      `rows: "${infos.slice(0, 3).join('" | "')}"`);
    check(await pathNow(page) === '/playlist/夜光4-8,海眸83-245,𓇰𓇶203-204', `address bar: ${await pathNow(page)}`);
    check(codeRequests.length === 1 && codeRequests[0].length === 3, `all 3 codes looked up in ${codeRequests.length} request`);
    await page.click('text=Copy playlist link'); await wait(150);
    check(await clip(page) === 'https://spotiky.com/playlist/夜光4-8,海眸83-245,𓇰𓇶203-204', `copy playlist link -> ${await clip(page)}`);
    await page.close();
  }
  {
    const page = await open('/playlist/夜光.4-.6,海眸1.23-1.25,𓇰𓇶3.23-3.24');
    await page.click('text=Play playlist');
    await wait(11500);
    const c = await calls(page);
    const seq = (await loads(page)).join(' → ');
    const pauses = c.filter(x => x.pause && x.pos > 3000).map(x => `${short(x.id)}@${(x.pos / 1000).toFixed(1)}`);
    check(seq === 'ID1@4 → ID2@83 → ID3@203', `plays in order: ${seq}`);
    check(pauses.join(' ') === 'ID1@6.0 ID2@85.0 ID3@204.0', `each clip stops on time: ${pauses.join(', ')}`);
    check(await status(page) === 'Playlist finished', `then "${await status(page)}"`);
    await page.close();
  }
  {
    const page = await open(`/playlist/夜光4-5,月光,${ID4}$10-11`);
    await wait(700);
    const nums = await page.$$eval('#rows .num', els => els.map(e => e.textContent));
    const info2 = await page.$eval('#rows .row:nth-child(2) .info', e => [e.className, e.textContent]);
    check(info2[0].includes('bad') && info2[1] === 'No song has the code 月光 yet' && nums.slice(0, 3).join(',') === '1,,2', 'an unknown code is flagged and left unnumbered');
    await page.click('text=Play playlist'); await wait(3600);
    check((await loads(page)).join(' → ') === `ID1@4 → ID4@10`, `mixed codes + IDs play, skipping the unknown one: ${(await loads(page)).join(' → ')}`);
    await page.close();
  }
  {
    const page = await open('/playlist');
    await page.click('#rows input');
    await page.evaluate(t => navigator.clipboard.writeText(t), '夜光.4-.8,海眸1.23-4.05, 𓇰𓇶3.23-3.24');
    await page.keyboard.press('Control+V'); await wait(400);
    const vals = await page.$$eval('#rows input', els => els.map(e => e.value));
    check(vals.length === 4 && await pathNow(page) === '/playlist/夜光4-8,海眸83-245,𓇰𓇶203-204', 'pasting your example into the editor makes 3 rows');
    await page.fill('#rows .row:last-child input', 'https://spotiky.com/海眸1:23');
    await wait(300);
    check((await pathNow(page)).endsWith(',海眸83'), 'a pasted spotiky.com code link becomes a row');
    await page.close();
  }
  {
    const page = await open('/playlist/夜光.4-.8,🌃💡1.23-1.25, 𓇰𓇶3.23-3.24');
    await wait(700);
    const infos = await page.$$eval('#rows .info', els => els.map(e => e.textContent));
    check(infos[1] === 'Dreams · 1:23–1:25' && decodeURIComponent(await page.evaluate(() => location.pathname)) === '/playlist/夜光4-8,🌃💡83-85,𓇰𓇶203-204',
      `Chinese, emoji and hieroglyph codes mix in one playlist: ${decodeURIComponent(await page.evaluate(() => location.pathname))}`);
    await page.close();
  }
  {
    codeRequests = [];
    const page = await open('/playlist/💃🏿🌃1:23-1:25,🌃💡,💃🌃10');
    await wait(700);
    const infos = await page.$$eval('#rows .info', els => els.map(e => e.textContent));
    check(infos[0] === 'Midnight City · 1:23–1:25' && infos[2] === 'Midnight City · from 0:10' && await pathNow(page) === '/playlist/💃🏿🌃83-85,🌃💡,💃🌃10',
      `toned and plain emoji codes in a playlist: ${await pathNow(page)}`);
    check(codeRequests.flat().sort().join() === '🌃💡,💃🌃', `one lookup per code, without tones: ${codeRequests.flat().join()}`);
    await page.click('text=Play playlist'); await wait(1500);
    check((await loads(page))[0] === 'ID3@83', 'and the toned row plays');
    await page.close();
  }
  for (const [p, want, label] of [
    ['/playlist/夜光1,23-1,45', 'Blinding Lights · 1:23–1:45', 'decimal commas inside times'],
    ['/playlist/夜光', 'Blinding Lights · whole song', 'a lone code is a one-song playlist'],
  ]) {
    const page = await open(p); await wait(600);
    const info = await page.$eval('#rows .row:first-child .info', e => e.textContent);
    const notice = await page.isVisible('#spotifyPlaylistNotice');
    check(info === want && !notice, `${label}: "${info}"`);
    await page.close();
  }
  {
    const page = await open('/playlist/月光,星海');
    await page.click('text=Play playlist'); await wait(500);
    check(await status(page) === 'None of these codes has a song yet' && !(await loads(page)).length, `only unknown codes: "${await status(page)}"`);
    await page.close();
  }

  console.log('\n### Spotiky links pasted anywhere');
  {
    const page = await open('/');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('ready'));
    const pasteInto = async (sel, text) => { await page.fill(sel, ''); await page.click(sel); await page.evaluate(t => navigator.clipboard.writeText(t), text); await page.keyboard.press('Control+V'); await wait(300); };
    await pasteInto('#link', `https://spotiky.com/track/${ID1}$1:23-1:45`);
    check(await page.inputValue('#time') === '1:23' && await page.inputValue('#endTime') === '1:45', 'pasting a Spotiky clip link into the song box shows its times');
    await page.click('text=Play from timestamp'); await wait(300);
    check((await loads(page)).pop() === 'ID1@83', '…Play starts the clip at 1:23');
    await page.click('text="Copy link"'); await wait(150);
    check(await clip(page) === `https://open.spotiky.com/track/${ID1}$83-105`, `…and Copy keeps the clip: ${short(await clip(page))}`);
    await page.fill('#time', ''); await page.fill('#endTime', '');
    await page.fill('#link', `https://open.spotiky.com/track/${ID4}?si=abc$1.23`);
    await page.click('text="Copy link"'); await wait(150);
    check(await clip(page) === `https://open.spotiky.com/track/${ID4}$83`, `a typed-in link uses its own start when the boxes are empty: ${short(await clip(page))}`);
    await page.fill('#link', `https://spotiky.com/?track=${ID2}&t=1:23`);
    await page.click('text=Play from timestamp'); await wait(300);
    check((await loads(page)).pop() === 'ID2@83', 'older ?track=ID&t=1:23 links work in the box');
    await pasteInto('#link', 'https://spotiky.com/%F0%9F%8C%83%F0%9F%92%A11:23');
    await page.click('text=Play from timestamp'); await wait(400);
    check(await page.inputValue('#time') === '1:23' && (await loads(page)).pop() === 'ID4@83', 'a percent-encoded code link, as browsers copy it, plays from its time');
    await page.fill('#link', `https://spotiky.com/playlist/${ID1}$4-8,夜光`);
    await Promise.all([page.waitForURL(/\/playlist\//), page.click('text=Play from timestamp')]);
    await wait(600);
    const vals = await page.$$eval('#rows input', els => els.map(e => e.value));
    check(vals[0] === `${ID1}$4-8` && vals[1] === '夜光', `a Spotiky playlist link in the song box opens the playlist page: ${short(vals.filter(Boolean).join(', '))}`);
    await page.close();
  }
  {
    const page = await open('/playlist');
    const pasteRow = async text => { const sel = '#rows .row:last-child input'; await page.click(sel); await page.evaluate(t => navigator.clipboard.writeText(t), text); await page.keyboard.press('Control+V'); await wait(600); };
    await pasteRow(`https://spotiky.com/track/${ID1}$1:23`);   // copied from the song page's address bar
    await pasteRow('https://spotiky.com/%E6%B5%B7%E7%9C%B8.4-.8');   // 海眸.4-.8, percent-encoded as copied
    await pasteRow('https://spotiky.com/playlist/k7f%E6%98%9F%E5%BF%83');   // a playlist's short link: k7f星心
    let rows = await page.$$eval('#rows .row', rs => rs.map(r => r.querySelector('.info').textContent));
    check(rows.join(' | ') === 'Blinding Lights · from 1:23 | Ocean Eyes · 0:04–0:08 | Blinding Lights · 0:04–0:08 | Ocean Eyes · whole song | ',
      `song links, code links and a playlist's short link pasted into rows: ${rows.join(' | ')}`);
    check(await pathNow(page) === `/playlist/${ID1}$83,海眸4-8,${ID1}$4-8,${ID2}`, `address bar: ${short(await pathNow(page))}`);
    await page.evaluate(t => { const i = document.querySelector('#rows .row:last-child input'); i.value = t; i.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: t, bubbles: true })); },
      'https://spotiky.com/playlist/夜光,🌃💡');   // a phone keyboard's clipboard button sends no paste event
    await wait(500);
    rows = await page.$$eval('#rows .row', rs => rs.map(r => r.querySelector('.info').textContent));
    check(rows.slice(4).join(' | ') === 'Blinding Lights · whole song | Dreams · whole song | ', `…and when a keyboard inserts a playlist link without pasting: ${rows.slice(4).join(' | ')}`);
    await page.fill('#rows .row:last-child input', `https://open.spotiky.com/playlist/${'P'.repeat(22)}`);
    await wait(200);
    check((await page.textContent('#rows .row:last-child .info')).startsWith("That's a Spotify playlist link"), 'a Spotify playlist with f→k swapped still says playlists come later');
    await page.close();
  }

  console.log('\n### Playlist short links');
  for (const [p, want, label] of [
    ['/playlist/k7f星心', '/playlist/k7f星心', 'a short link keeps its label'],
    ['/playlist/K7F-star-heart', '/playlist/k7f-star-heart', 'any of its labels; capitals in the ID go small'],
    ['/playlist/k7f', '/playlist/k7f星心', 'just the ID gains the Chinese label'],
    ['/playlist/k7f夜光', '/playlist/k7f星心', 'a wrong label still opens it and corrects itself'],
  ]) {
    const page = await open(p); await wait(700);
    const vals = await page.$$eval('#rows input', els => els.map(e => e.value).filter(Boolean));
    const now = await pathNow(page);
    check(vals.join(',') === `${ID1}$4-8,${ID2}` && now === want, `${label.padEnd(44)} ${p.padEnd(26)} -> ${now}`);
    await page.close();
  }
  {
    const page = await open('/playlist/zzz9'); await wait(700);
    check(/No playlist has this link/.test(await status(page)) && (await page.$$('#rows .row')).length === 1, `an unknown short link says so: "${await status(page)}"`);
    await page.close();
    const p2 = await open('/'); await p2.waitForFunction(() => document.getElementById('status').textContent.includes('ready'));
    await p2.fill('#link', 'https://spotiky.com/playlist/k7f星心');
    await Promise.all([p2.waitForURL(/\/playlist\//), p2.click('text=Play from timestamp')]);
    await wait(700);
    check((await p2.$$eval('#rows input', els => els.map(e => e.value).filter(Boolean))).join(',') === `${ID1}$4-8,${ID2}`, 'a short link in the song box opens the playlist');
    await p2.close();
    // A playlist's code on its own works in the song box too, with Play or Share
    for (const [typed, want, how] of [['k7f星心', '/playlist/k7f星心', 'Play from timestamp'], ['K7F', '/playlist/k7f星心', 'Play from timestamp'], ['k7f-star-heart', '/playlist/k7f-star-heart', 'Share as a code']]) {
      const pb = await open('/'); await pb.waitForFunction(() => document.getElementById('status').textContent.includes('ready'));
      await pb.fill('#link', typed);
      await Promise.all([pb.waitForURL(/\/playlist\//), pb.click(`text=${how}`)]);
      await wait(700);
      const vals = (await pb.$$eval('#rows input', els => els.map(e => e.value).filter(Boolean))).join(',');
      check(vals === `${ID1}$4-8,${ID2}` && await pathNow(pb) === want, `the bare code ${typed} in the song box + ${how} opens the playlist (${await pathNow(pb)})`);
      await pb.close();
    }
    {
      const pb = await open('/'); await pb.waitForFunction(() => document.getElementById('status').textContent.includes('ready'));
      await pb.fill('#link', 'kzf星心');   // no digit: not a playlist ID
      await pb.click('text=Play from timestamp'); await wait(300);
      check(/Please enter a Spotify or Spotiky song link/.test(await status(pb)) && !/playlist/.test(pb.url()), `an ID without a digit isn't a playlist: "${await status(pb)}"`);
      await pb.close();
    }
    const p3 = await open('/playlist/k7f星心'); await wait(700);
    await p3.fill('#rows .row:nth-child(2) input', `${ID2}$10`); await wait(200);
    check(await pathNow(p3) === `/playlist/${ID1}$4-8,${ID2}$10` && await p3.isHidden('#ownerBar'), 'someone else editing it gets the full link (and no Save button)');
    await p3.click('text=Copy playlist link'); await wait(150);
    check(await clip(p3) === `https://spotiky.com/playlist/${ID1}$4-8,${ID2}$10`, 'and Copy playlist link copies that');
    await p3.close();
  }

  {
    // A full Spotify link in a row becomes its track ID, times kept, after a paste or on leaving the box
    const page = await open('/playlist');
    const pasteRow = async text => { const sel = '#rows .row:last-child input'; await page.click(sel); await page.evaluate(t => navigator.clipboard.writeText(t), text); await page.keyboard.press('Control+V'); await wait(600); };
    await pasteRow(`https://open.spotify.com/track/${ID1}?si=4f1c2b9e8a7d4c3b`);
    await pasteRow(`https://open.spotify.com/track/${ID2}?si=abc&t=83`);
    await pasteRow('夜光.4-.8');
    await page.fill('#rows .row:last-child input', `https://open.spotify.com/intl-fr/track/${ID1}`);
    await page.press('#rows .row:last-child input', 'Tab'); await wait(300);
    const vals = (await page.$$eval('#rows input', els => els.map(e => e.value))).filter(Boolean);
    check(vals.join(',') === `${ID1},${ID2}$83,夜光.4-.8,${ID1}`, `Spotify links in rows shrink to the track ID (codes stay as typed): ${short(vals.join(', '))}`);
    const infos = await page.$$eval('#rows .row .info', els => els.map(e => e.textContent).filter(Boolean));
    check(infos[0] === 'Blinding Lights · whole song' && infos[1] === 'Ocean Eyes · from 1:23', `and each still shows its song: ${infos.slice(0, 2).join(' | ')}`);
    await page.close();
  }
  {
    // spotiky.com/account is the collection page: signed out, it opens Sign in and says what it's for
    const page = await open('/account'); await wait(600);
    const shown = await page.isVisible('#accountPanel #signInEmail');
    await page.click('#accountPanel .share-head button'); await wait(100);
    check(shown && await page.isHidden('#accountPanel') && await pathNow(page) === '/account' && await page.isHidden('#trackView')
      && /Sign in to keep your playlists here/.test(await page.textContent('#collectionView')),
      `spotiky.com/account opens Sign in; closed, the collection page asks you to sign in (${await pathNow(page)})`);
    await page.click('#collectionView button >> text=Sign in'); await wait(100);
    check(await page.isVisible('#accountPanel #signInEmail'), 'its Sign in button opens the sign-in panel again');
    await page.close();
  }

  check(nonAscii.length === 0, `every copied link was plain ASCII${nonAscii.length ? ': ' + nonAscii.join(' ') : ''}`);
  console.log(`\n${pass} passed, ${fail} failed${errors.length ? '; PAGE ERRORS: ' + [...new Set(errors)].join(' | ') : '; no page errors'}`);
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
