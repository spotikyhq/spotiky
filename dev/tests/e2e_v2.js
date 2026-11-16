// Browser tests for Spotiky clips + playlists.
// Serves the repo like GitHub Pages (unknown paths -> 404.html, status 404) and swaps the
// Spotify IFrame API for a simulated player that reports its position once a second.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = process.argv[2];

const ID = '7gaA3wERFkFkgivjwbSvkG';
const ID1 = 'A'.repeat(21) + '1', ID2 = 'B'.repeat(21) + '2', ID3 = 'C'.repeat(21) + '3',
      ID4 = 'D'.repeat(21) + '4', ID5 = 'E'.repeat(21) + '5';
const SI = '1a2b3c4d5e6f4a7b', SPL = '37i9dQZF1DXcBWIGoYBM5M';

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split(/[?#]/)[0]);
  const fp = path.join(ROOT, p === '/' ? 'index.html' : p.slice(1));
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) { res.writeHead(200, { 'Content-Type': /\.js$/.test(fp) ? 'application/javascript' : 'text/html' }); return res.end(fs.readFileSync(fp)); }
  res.writeHead(404, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(ROOT, '404.html')));
});

// Simulated Spotify embed controller: position moves with the clock, reported every TICK ms
const FAKE_API = `
(function () {
  const TICK = window.__TICK_MS || 1000;
  window.__calls = [];
  let cur = null, listeners = [], last = performance.now();
  const live = () => cur ? cur.pos + (cur.playing ? performance.now() - last : 0) : 0;
  const emit = () => {
    if (!cur) return;
    const d = { playingURI: cur.uri, position: Math.round(cur.pos), duration: cur.dur, isPaused: !cur.playing, isBuffering: false };
    listeners.forEach(fn => fn({ data: d }));
  };
  setInterval(() => {
    const now = performance.now();
    if (cur && cur.playing) {
      cur.pos += now - last;
      if (cur.pos >= cur.dur) { cur.pos = cur.dur; cur.playing = false; window.__calls.push({ ended: cur.uri.slice(-22) }); }
      emit();
    }
    last = now;
  }, TICK);
  const ctrl = {
    loadEntity(uri, preferVideo, at) {
      const id = uri.split(':').pop();
      window.__calls.push({ load: id, at, t: performance.now() });
      const preview = (window.__PREVIEW || {})[id];
      cur = { uri, dur: preview ? 30000 : ((window.__DURS || {})[id] || 200000), pos: preview ? 0 : (at || 0) * 1000, playing: false };
    },
    play() { window.__calls.push({ play: true, t: performance.now() }); if (cur) { cur.pos = live(); cur.playing = true; last = performance.now(); emit(); } },
    pause() {
      const p = Math.round(live());
      window.__calls.push({ pause: true, pos: p, id: cur && cur.uri.slice(-22), t: performance.now() });
      if (cur) { cur.pos = p; cur.playing = false; last = performance.now(); emit(); }
    },
    seek(s) { if (cur) { cur.pos = s * 1000; last = performance.now(); emit(); } },
    addListener(ev, fn) { if (ev === 'playback_update') listeners.push(fn); },
  };
  window.__ctrl = ctrl;
  (function wait() {
    if (!window.onSpotifyIframeApiReady) return setTimeout(wait, 10);
    window.onSpotifyIframeApiReady({ createController(el, opts, cb) { cb(ctrl); } });
  })();
})();`;

let pass = 0, fail = 0;
const errors = [];
const check = (ok, line) => { ok ? pass++ : fail++; console.log((ok ? 'ok   ' : 'FAIL ') + line); };
const short = s => String(s).split(ID).join('ID').split(ID1).join('ID1').split(ID2).join('ID2')
  .split(ID3).join('ID3').split(ID4).join('ID4').split(ID5).join('ID5').split(SI).join('SI');

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('https://open.spotify.com/embed/iframe-api')) return route.fulfill({ contentType: 'application/javascript', body: FAKE_API });
    if (u.startsWith(base)) return route.continue();
    if (u.includes('spotiky-preview')) {
      const id = new URL(u).searchParams.get('id') || '';
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ name: 'Song ' + id.slice(0, 3), preview_url: null }) });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  const open = async (url, init = {}) => {
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript(cfg => Object.assign(window, cfg), init);
    await page.goto(base + url);
    await page.waitForFunction(() => window.__calls !== undefined);
    return page;
  };
  const calls = page => page.evaluate(() => window.__calls);
  const status = page => page.textContent('#status');
  const pathNow = page => page.evaluate(() => decodeURIComponent(location.pathname));
  const clipboard = page => page.evaluate(() => navigator.clipboard.readText());
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ---------------------------------------------------------------- clips
  console.log('\n### Clips on the track page (player reports position once a second)');
  {
    const page = await open(`/track/${ID}$83-86`);
    await wait(3000);
    const mid = await status(page);
    await wait(2500);
    let c = await calls(page);
    const load = c.find(x => x.load), pause = c.find(x => x.pause);
    check(load && load.at === 83, `/track/ID$83-86 loads the song at 1:23`);
    check(/^Playing 1:2[45] \/ 1:26 \(3:20\)$/.test(mid), `while playing, status reads "${mid}"`);
    check(pause && Math.abs(pause.pos - 86000) < 300, `stops at 1:26 (off by ${pause ? pause.pos - 86000 : '?'} ms)`);
    const st = await status(page);
    check(st === 'Clip ended (1:23–1:26)' && await page.isVisible('#replayBtn') && (await page.textContent('#replayBtn')) === '↺ Replay clip', `then "${st}" with a ↺ Replay clip button`);
    check(await page.inputValue('#endTime') === '86' && await page.isVisible('[aria-label="Set start to now"]') && await page.isVisible('[aria-label="Set end to now"]'), 'End box filled from the link; the Now buttons appear in the time boxes once playing');
    await page.click('#replayBtn');
    await wait(4600);
    c = await calls(page);
    const loads = c.filter(x => x.load), pauses = c.filter(x => x.pause);
    check(loads.length === 2 && loads[1].at === 83 && Math.abs(pauses[pauses.length - 1].pos - 86000) < 300,
      `Replay plays 1:23–1:26 again (stopped ${pauses[pauses.length - 1].pos - 86000} ms off)`);
    await page.close();
  }
  {
    const page = await open(`/track/${ID}$83-90`);
    await wait(2500);
    await page.evaluate(() => window.__ctrl.seek(120));
    await wait(8000);
    const c = await calls(page), st = await status(page);
    check(!c.some(x => x.pause) && /^Playing 2:0\d \/ 3:20$/.test(st), `dragging the slider past the end keeps playing ("${st}")`);
    await page.close();
  }
  {
    const page = await open(`/track/${ID}$83`);
    await wait(3000);
    await page.click('[aria-label="Set start to now"]');
    const s = await page.inputValue('#time');
    await wait(2000);
    await page.click('[aria-label="Set end to now"]');
    const e = await page.inputValue('#endTime');
    const sec = v => v.split(':').reduce((a, b) => a * 60 + +b, 0);
    check(/^1:2[4-6]$/.test(s) && sec(e) - sec(s) >= 1 && sec(e) - sec(s) <= 3, `Start's Now -> ${s}, End's Now 2 s later -> ${e}`);
    await page.close();
  }

  console.log('\n### Clip links in every time format');
  {
    const page = await open('/');
    const cases = [
      [`/track/${ID}$83-105`, 83, 105], [`/track/${ID}.83-$1:45`, 83, 105], [`/track/${ID}&t=1:23-1:45`, 83, 105],
      [`/track/${ID}?si=${SI}$1:23-1:45`, 83, 105], [`/track/${ID}?si=${SI}&t=83-105`, 83, 105],
      [`/track/${ID}$1.23-1.45`, 83, 105], [`/track/${ID}.83-.105`, 83, 105], [`/track/${ID}?si=${SI}.83-.105`, 83, 105],
      [`/track/${ID}&t=83-$1:45`, 83, 105], [`/track/${ID}%241%3A23-1%3A45`, 83, 105],
      [`/track/${ID}$1:23-`, 83, null], [`/track/${ID}$1:45-1:23`, 105, null], [`/track/${ID}$83`, 83, null],
    ];
    for (const [u, s, e] of cases) {
      const r = await page.evaluate(u => { const x = parseShareUrl(u); const st = parseTime(x.time || '0'); return [st, cleanEnd(st, x.end)]; }, u);
      check(r[0] === s && r[1] === e, `${short(u).padEnd(30)} -> ${r[0]}s to ${r[1] === null ? 'the end' : r[1] + 's'}`);
    }
    await page.close();
  }

  console.log('\n### Earlier link formats still behave the same');
  for (const [tpl, want] of [
    ['/track/ID$83', 83], ['/track/ID&t=1:23', 83], ['/track/ID.83', 83], ['/track/ID$1.23', 83], ['/track/ID$83?si=SI', 83],
    ['/?track=ID&t=83', 83], ['/#track/ID.83', 83], ['/track/ID?si=SI$83', 83], ['/track/ID?si=SI&t=83', 83],
    ['/track/ID?si=SI&t=1:23', 83], ['/track/ID?si=SI.83', 83], ['/track/ID?t=83', 83], ['/intl-de/track/ID?si=SI$83', 83],
    ['/track/ID%2483', 83], ['/track/ID', 0], ['/track/ID?si=SI', 0], ['/', null],
  ]) {
    const page = await open(tpl.replace('ID', ID).replace('SI', SI));
    await wait(1100);
    const load = (await calls(page)).find(x => x.load);
    const got = load ? load.at : null;
    check(got === want, `${tpl.padEnd(28)} -> ${got === null ? 'nothing plays' : 'starts at ' + got + 's'}`);
    await page.close();
  }
  for (const [t, end, wantLink] of [['$83', '', '$83'], ['$1.23', '', '$83'], ['1:23', '1:45', '$83-105'], ['1:23', '$1.45', '$83-105'], ['1:23', '1:00', '$83']]) {
    const page = await open('/');
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('ready'));
    await page.fill('#link', `https://open.spotify.com/track/${ID}?si=${SI}`);
    await page.fill('#time', t);
    await page.fill('#endTime', end);
    await page.click('text=Play from timestamp');
    await page.click('text="Copy link"');
    await wait(150);
    const at = (await calls(page)).find(x => x.load).at, link = await clipboard(page);
    check(at === 83 && link === `https://open.spotiky.com/track/${ID}${wantLink}`,
      `start "${t}" end "${end}" -> starts at ${at}s, copies ${short(link)}`);
    await page.close();
  }

  // ---------------------------------------------------------------- playlists
  console.log('\n### Playlist playback');
  {
    const page = await open(`/playlist/${ID1}$83-85,${ID2}$10-12,${ID3}`, { __DURS: { [ID3]: 4000 } });
    const vals = await page.$$eval('#rows input', els => els.map(e => e.value));
    check(vals.length === 4 && vals[3] === '' && await pathNow(page) === `/playlist/${ID1}$83-85,${ID2}$10-12,${ID3}`,
      `shared link opens as ${vals.length - 1} songs + an empty row, address bar unchanged`);
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('ready'));
    check(await status(page) === 'Player ready – press Play playlist', `waits for a tap: "${await status(page)}"`);
    await page.click('text=Play playlist');
    await wait(5000);
    const mid = await status(page);
    const highlighted = await page.$$eval('#rows .row', rs => rs.findIndex(r => r.classList.contains('playing')));
    await wait(7500);
    const c = await calls(page);
    const loads = c.filter(x => x.load).map(x => `${short(x.load)}@${x.at}`);
    const pauses = c.filter(x => x.pause);
    check(loads.join(' ') === 'ID1@83 ID2@10 ID3@0', `plays in order: ${loads.join(' → ')}`);
    check(pauses.length >= 2 && Math.abs(pauses[0].pos - 85000) < 300 && Math.abs(pauses[1].pos - 12000) < 300,
      `clip 1 stops at 1:25 (${pauses[0] && pauses[0].pos - 85000} ms off), clip 2 at 0:12 (${pauses[1] && pauses[1].pos - 12000} ms off)`);
    check(/^Song 2 of 3 · Playing 0:1[01] \/ 0:12 \(3:20\)$/.test(mid) && highlighted === 1, `during song 2: "${mid}", row 2 highlighted`);
    const st = await status(page), rb = await page.textContent('#replayBtn');
    check(st === 'Playlist finished' && rb === '↺ Replay playlist' && await page.isHidden('#plControls'),
      `song 3 plays to its natural end, then "${st}" + ${rb}`);
    await page.click('#replayBtn');
    await wait(1200);
    const again = (await calls(page)).filter(x => x.load).map(x => `${short(x.load)}@${x.at}`);
    check(again[again.length - 1] === 'ID1@83', 'Replay playlist starts again from song 1');
    await page.close();
  }
  {
    const page = await open(`/playlist/${ID1}$83-95,${ID2}$10-20,${ID3}$5`);
    await page.click('text=Play playlist');
    await wait(2000);
    await page.click('text=Next ⏭');
    await wait(1500);
    await page.click('text=⏮ Previous');
    await wait(1500);
    const c = await calls(page);
    const seq = c.filter(x => x.load || x.pause).map(x => x.load ? `${short(x.load)}@${x.at}` : 'pause');
    check(seq.join(' ') === 'ID1@83 pause ID2@10 pause ID1@83', `Next / Previous: ${seq.join(' → ')}`);
    await page.click('#rows .row:nth-child(3) .num');
    await wait(400);
    const last = (await calls(page)).filter(x => x.load).pop();
    check(short(last.load) === 'ID3' && last.at === 5, 'tapping a song\'s number plays from that song');
    await page.close();
  }
  {
    const page = await open(`/playlist/${ID5}$40-45`, { __PREVIEW: { [ID5]: true } });
    await page.click('text=Play playlist');
    await wait(2500);
    const c = await calls(page);
    check(await page.isVisible('#loginPrompt') && c.some(x => x.pause) && await status(page) === 'Log in to Spotify to play this playlist',
      'logged out (Spotify only plays a preview): pauses and asks to log in');
    check(await page.getAttribute('#loginPrompt a', 'href') === 'https://accounts.spotify.com/login', 'log-in button goes to Spotify\'s log-in page');
    await page.close();
  }
  {
    const page = await open(`/playlist/${SPL}`);
    check(await page.isVisible('#spotifyPlaylistNotice') && await page.getAttribute('#spotifyPlaylistLink', 'href') === `https://open.spotify.com/playlist/${SPL}`
      && (await page.$$('#rows .row')).length === 1, 'a real Spotify playlist ID gets the "not supported yet" note + Open on Spotify');
    await page.close();
  }

  console.log('\n### Playlist editor');
  {
    const page = await open('/playlist');
    const paste = async (text) => { await page.evaluate(t => navigator.clipboard.writeText(t), text); await page.keyboard.press('Control+V'); await wait(150); };
    const rows = () => page.$$eval('#rows input', els => els.map(e => e.value));
    const focusedRow = () => page.evaluate(() => [...document.querySelectorAll('#rows input')].indexOf(document.activeElement));
    await page.click('#rows input');
    await paste(`https://open.spotify.com/track/${ID1}?si=${SI}, ${ID2}$1:23-1:45\n/track/${ID3}.83`);
    let r = await rows();
    check(r.length === 4 && r[3] === '' && await focusedRow() === 3, `pasting 3 links at once makes 3 rows + an empty one, cursor in the empty row`);
    check(await pathNow(page) === `/playlist/${ID1},${ID2}$83-105,${ID3}$83`, `address bar: ${short(await pathNow(page))}`);
    await wait(400);
    const infos = await page.$$eval('#rows .info', els => els.map(e => e.textContent));
    check(infos[0] === 'Song AAA · whole song' && infos[1] === 'Song BBB · 1:23–1:45' && infos[2] === 'Song CCC · from 1:23',
      `rows show name + clip: "${infos.slice(0, 3).join('" | "')}"`);
    await paste(`https://open.spotiky.com/track/${ID4}$1:00`);
    r = await rows();
    check(r.length === 5 && await focusedRow() === 4 && (await pathNow(page)).endsWith(`,${ID4}$60`), 'pasting one link opens a new empty row and moves the cursor there');
    await page.focus('#rows .row:nth-child(2) input');
    await page.keyboard.press('Enter');
    r = await rows();
    check(r.length === 6 && r[2] === '' && await focusedRow() === 2, 'Enter adds a row right below');
    await page.keyboard.press('Backspace');
    r = await rows();
    check(r.length === 5 && await focusedRow() === 1, 'Backspace in an empty row removes it');
    await page.click('#rows .row:nth-child(1) .remove');
    const nums = await page.$$eval('#rows .num', els => els.map(e => e.textContent));
    check(await pathNow(page) === `/playlist/${ID2}$83-105,${ID3}$83,${ID4}$60` && nums.join(',') === '1,2,3,', `✕ removes a song and renumbers (${nums.filter(Boolean).join(', ')})`);
    await page.click('text=Copy playlist link');
    await wait(150);
    check(await clipboard(page) === `https://spotiky.com/playlist/${ID2}$83-105,${ID3}$83,${ID4}$60`, `Copy playlist link -> ${short(await clipboard(page))}`);
    await page.click('#rows .row:last-child input');
    await page.keyboard.type(`https://open.spotify.com/playlist/${SPL}?si=x`);
    let bad = await page.$eval('#rows .row:last-child .info', e => [e.className, e.textContent]);
    check(bad[0].includes('bad') && bad[1].startsWith("That's a Spotify playlist link"), 'a Spotify playlist link in a row gets flagged');
    await page.fill('#rows .row:last-child input', 'https://open.spotify.com/album/1A2GTWGtFfWp7KSQTwWOyo');
    bad = await page.$eval('#rows .row:last-child .info', e => e.textContent);
    check(bad === 'Only song links work here', 'an album link gets flagged');
    await page.close();
  }
  {
    const page = await open('/playlist');
    await page.click('#rows input');
    await page.evaluate(t => navigator.clipboard.writeText(t), ID1);
    await page.keyboard.press('Control+V');
    await wait(150);
    const p = await pathNow(page);
    const page2 = await open(p);
    const r = await page2.$$eval('#rows input', els => els.map(e => e.value));
    check(p === `/playlist/${ID1}$0` && r[0] === `${ID1}$0` && await page2.isHidden('#spotifyPlaylistNotice'),
      `a one-song playlist gets ${short(p)}, so it isn't mistaken for a Spotify playlist`);
    const page4 = await open('/playlist');
    await page4.click('#rows input');
    await page4.evaluate(t => navigator.clipboard.writeText(t), `https://spotiky.com/playlist/${ID3}$5-9,${ID4}`);
    await page4.keyboard.press('Control+V');
    await wait(150);
    check(await pathNow(page4) === `/playlist/${ID3}$5-9,${ID4}`, 'pasting a whole Spotiky playlist link brings in its songs');
    await page.close(); await page2.close(); await page4.close();
  }

  console.log('\n### Clip-end decisions (unit)');
  {
    const page = await open('/');
    const T = [
      ['before the end', [{ pos: 84000, at: 0, playing: true }, 85000, 1000, 86000], 'continue'],
      ['normal crossing', [{ pos: 85000, at: 0, playing: true }, 86100, 1100, 86000], 'end'],
      ['buffering stall, then crossing', [{ pos: 84000, at: 0, playing: true }, 86100, 6000, 86000], 'end'],
      ['slider dragged past the end', [{ pos: 84000, at: 0, playing: true }, 120000, 1000, 86000], 'seekedPast'],
      ['page asleep 66 s while playing', [{ pos: 84000, at: 0, playing: true }, 150000, 66000, 86000], 'end'],
      ['moved past the end while paused', [{ pos: 84000, at: 0, playing: false }, 120000, 9000, 86000], 'seekedPast'],
      ['first report already past the end', [null, 90000, 0, 86000], 'end'],
    ];
    for (const [name, args, want] of T) {
      const got = await page.evaluate(a => classifyProgress(...a), args);
      check(got === want, `${name.padEnd(34)} -> ${got}`);
    }
    console.log('\n### Preview detection (unit)');
    for (const [name, dur, start, want] of [
      ['30 s duration (typical preview)', 30000, 0, true], ['29.5 s duration, start 0:10', 29500, 10, true],
      ['4 s real song from 0:00', 4000, 0, false], ['20 s real song from 0:00', 20000, 0, false],
      ['20 s audio but we asked for 1:23', 20000, 83, true], ['3:20 song from 1:23', 200000, 83, false],
    ]) {
      const got = await page.evaluate(([d, s]) => looksLikePreview(d, s), [dur, start]);
      check(got === want, `${name.padEnd(34)} -> ${got ? 'preview' : 'real song'}`);
    }
    await page.close();
  }

  console.log(`\n${pass} passed, ${fail} failed${errors.length ? '; PAGE ERRORS: ' + [...new Set(errors)].join(' | ') : '; no page errors'}`);
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
