// Browser tests for "Share as a code": a fake Worker answers /suggest, /claim and /codes.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = process.argv[2], SHOTS = process.argv[3];
const ID1 = 'A'.repeat(21) + '1', ID2 = 'B'.repeat(21) + '2';

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split(/[?#]/)[0]);
  const fp = path.join(ROOT, p === '/' ? 'index.html' : p.slice(1));
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) { res.writeHead(200, { 'Content-Type': /\.js$/.test(fp) ? 'application/javascript' : 'text/html' }); return res.end(fs.readFileSync(fp)); }
  res.writeHead(404, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(ROOT, '404.html')));
});
const FAKE_API = `(function(){window.__calls=[];const ctrl={loadEntity(u,v,a){window.__calls.push({load:u.split(':').pop(),at:a});},play(){},pause(){},addListener(){}};
(function w(){if(!window.onSpotifyIframeApiReady)return setTimeout(w,10);window.onSpotifyIframeApiReady({createController(e,o,cb){cb(ctrl);}});})();})();`;

const SUGGEST = {
  existing: false,
  zh: { code: '夜光', chars: [{ char: '夜', meaning: 'night' }, { char: '光', meaning: 'light' }], word: null, why: 'Neon city nights, chasing someone', taken: false, saved: false,
        options: [[{ char: '夜', meaning: 'night' }, { char: '月', meaning: 'moon' }], [{ char: '光', meaning: 'light' }, { char: '火', meaning: 'fire' }, { char: '灯', meaning: 'lamp' }]] },
  eg: { code: '𓇰𓇶', chars: [{ char: '𓇰', name: 'night', meaning: 'night, darkness' }, { char: '𓇶', name: 'sunshine', meaning: 'light, shine' }], why: 'Night and light', taken: false, saved: false,
        options: [[{ char: '𓇰', name: 'night', meaning: 'night, darkness' }, { char: '𓇼', name: 'star', meaning: 'star, hour' }], [{ char: '𓇶', name: 'sunshine', meaning: 'light, shine' }, { char: '𓊮', name: 'fire', meaning: 'fire, flame, heat' }]] },
  em: { code: '🌃💡', chars: [{ char: '🌃', name: 'night with stars', meaning: 'night with stars' }, { char: '💡', name: 'light bulb', meaning: 'light bulb' }], why: 'City lights after dark', taken: false, saved: false,
        options: [[{ char: '🌃', name: 'night with stars', toneable: false }, { char: '🌙', name: 'crescent moon', toneable: false }, { char: '💃', name: 'woman dancing', toneable: true }, { char: '🕺', name: 'man dancing', toneable: true }],
                  [{ char: '💡', name: 'light bulb', toneable: false }, { char: '🔦', name: 'flashlight', toneable: false }, { char: '🙌', name: 'raising hands', toneable: true }]] },
};
const EMOJI_NAMES = { '🌃': 'night with stars', '🌙': 'crescent moon', '💡': 'light bulb', '🔦': 'flashlight', '💃': 'woman dancing', '🕺': 'man dancing', '🙌': 'raising hands', '🎶': 'musical notes' };
const TONEABLE = new Set(['💃', '🕺', '🙌']);
const TONE_RE = /[\u{1F3FB}-\u{1F3FF}]/u;
const LABEL_SUGGEST = {
  zh: { code: '夜歌', chars: [{ char: '夜', meaning: 'night' }, { char: '歌', meaning: 'song' }], why: 'Songs for late nights', saved: false,
        options: [[{ char: '夜', meaning: 'night' }, { char: '星', meaning: 'star' }], [{ char: '歌', meaning: 'song' }, { char: '光', meaning: 'light' }]] },
  eg: { code: '𓇰𓇼', chars: [{ char: '𓇰', name: 'night', meaning: 'night, darkness' }, { char: '𓇼', name: 'star', meaning: 'star, hour' }], why: 'Night and stars', saved: false,
        options: [[{ char: '𓇰', name: 'night' }, { char: '𓇶', name: 'sunshine' }], [{ char: '𓇼', name: 'star' }, { char: '𓊮', name: 'fire' }]] },
  em: { code: '🙌🎶', chars: [{ char: '🙌', name: 'raising hands', toneable: true }, { char: '🎶', name: 'musical notes', toneable: false }], why: 'Hands up', saved: false,
        options: [[{ char: '🙌', name: 'raising hands', toneable: true }, { char: '🌙', name: 'crescent moon', toneable: false }], [{ char: '🎶', name: 'musical notes', toneable: false }, { char: '💡', name: 'light bulb', toneable: false }]] },
  en: { code: 'night-drive', chars: [{ char: 'night' }, { char: 'drive' }], why: 'Late drives under city lights', saved: false,
        options: [[{ char: 'night' }, { char: 'late' }], [{ char: 'drive' }, { char: 'ride' }]] },
};
const GLYPH_NAMES = { '𓇰': 'night', '𓇼': 'star', '𓇶': 'sunshine', '𓊮': 'fire' };
let pass = 0, fail = 0; const errors = [];
const check = (ok, line) => { ok ? pass++ : fail++; console.log((ok ? 'ok   ' : 'FAIL ') + line); };
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  let store, claims, suggests, mode, codeReqs, playlists, sessions, listSuggests, listSaves, authStarts;
  const verifies = []; let slowVerify = false;
  const reset = () => {
    store = { '夜灯': { type: 'track', id: ID2 } }; claims = []; suggests = []; mode = 'normal'; codeReqs = [];
    playlists = {}; sessions = {}; listSuggests = []; listSaves = []; authStarts = [];
  };
  // Saved playlists as the Worker describes them: labels with their characters' names
  const describeLabels = labels => Object.fromEntries(Object.entries(labels).filter(([k]) => ['zh', 'eg', 'em', 'en'].includes(k)).map(([k, l]) => [k, { code: l.code, saved: true,
    chars: k === 'zh' ? (l.chars || [...l.code].map(c => ({ char: c, meaning: '' })))
      : k === 'eg' ? [...l.code].map(c => ({ char: c, name: GLYPH_NAMES[c] || '' }))
      : k === 'em' ? [...l.code].map(c => ({ char: c, name: EMOJI_NAMES[c] || '', toneable: TONEABLE.has(c) }))
      : l.code.split('-').map(w => ({ char: w })) }]));
  const describe = (p, owner, withItems) => ({ id: p.id, labels: describeLabels(p.labels), typed: p.labels.typed || [], saved: true, mine: !!owner && p.owner === owner, owned: !!p.owner, ...(withItems ? { items: p.items } : {}) });
  const newCtx = async (viewport) => {
    const ctx = await browser.newContext(viewport ? { viewport, deviceScaleFactor: 2 } : {});
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await ctx.route('**/*', async route => {
      const req = route.request(), u = req.url();
      if (u.startsWith('https://open.spotify.com/embed/iframe-api')) return route.fulfill({ contentType: 'application/javascript', body: FAKE_API });
      if (u.startsWith('https://fonts.')) return route.fulfill({ status: 404, body: '' });
      if (u.startsWith(base)) return route.continue();
      const url = new URL(u), cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
      const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors, body: '' });
      if (url.pathname === '/codes') {   // like the real Worker's KV: codes are stored without skin tones, so a toned lookup would miss
        const asked = url.searchParams.get('c').split(','); codeReqs.push(...asked);
        return reply(200, Object.fromEntries(asked.map(c => [c, store[c] || null])));
      }
      const bearer = (req.headers()['authorization'] || '').replace(/^Bearer /, '');
      const who = sessions[bearer] || null;
      const body = req.method() === 'POST' ? JSON.parse(req.postData() || '{}') : null;
      if (url.pathname === '/auth/start') { authStarts.push(body.email); return reply(200, { sent: true, minutes: 10 }); }
      if (url.pathname === '/auth/verify') {
        verifies.push(body.code);
        if (slowVerify) await new Promise(r => setTimeout(r, 2500));   // a Worker waking up
        if (String(body.code).replace(/\D/g, '') !== '123456') return reply(400, { error: "That code isn't right", triesLeft: 4 });
        const token = 'tok' + Math.random().toString(36).slice(2).padEnd(24, 'x');
        sessions[token] = body.email.trim().toLowerCase();
        return reply(200, { token, expires: Date.now() + 30 * 864e5 });
      }
      if (url.pathname === '/auth/signout') { delete sessions[bearer]; return reply(200, { signedOut: true }); }
      if (url.pathname === '/playlists/mine') {
        if (!who) return reply(401, { error: 'Sign in to see your playlists' });
        return reply(200, { playlists: Object.values(playlists).filter(p => p.owner === who).map(p => describe(p, who, true)) });
      }
      if (url.pathname === '/playlist' && req.method() === 'GET') {
        const p = playlists[(url.searchParams.get('id') || '').toLowerCase()];
        return p ? reply(200, describe(p, who, true)) : reply(404, { error: 'No playlist has this link' });
      }
      if (url.pathname === '/playlist/suggest') {
        listSuggests.push({ ...body, auth: !!who });
        const own = who && Object.values(playlists).find(p => p.owner === who && p.items === body.items);
        if (own) return reply(200, describe(own, who));
        const snap = Object.values(playlists).find(p => !p.owner && p.items === body.items);
        if (snap && !who) return reply(200, describe(snap, null));
        return reply(200, { id: who ? 'v62' : 'k7f', ...(who ? { idSig: 'sig' } : {}), labels: JSON.parse(JSON.stringify(LABEL_SUGGEST)), saved: false, mine: !!who, owned: !!who });
      }
      if (url.pathname === '/playlist/save') {
        listSaves.push({ ...body, auth: !!who });
        await wait(200);
        if (body.edit) {
          const p = playlists[body.edit];
          if (!who) return reply(401, { error: 'Sign in to change your playlist' });
          if (!p || p.owner !== who) return reply(403, { error: 'Only its owner can change this playlist' });
          p.items = body.items;
          return reply(200, describe(p, who));
        }
        if (who) {
          const id = body.idSig === 'sig' && body.id ? body.id : 'r4n';
          playlists[id] = { id, items: body.items, labels: body.labels, owner: who };
          return reply(200, describe(playlists[id], who));
        }
        const snap = Object.values(playlists).find(p => !p.owner && p.items === body.items);
        if (snap) return reply(200, describe(snap, null));
        playlists.k7f = { id: 'k7f', items: body.items, labels: body.labels, owner: null };
        return reply(200, describe(playlists.k7f, null));
      }
      if (url.pathname === '/suggest') {
        suggests.push(body);
        if (mode === 'down') return reply(503, { error: "Codes aren't set up on this Worker yet" });
        const key = body.type === 'track' ? 'track:' + body.id : 'list:' + body.items;
        const saved = (store[key] && store[key].desc) || {};
        const out = JSON.parse(JSON.stringify(SUGGEST));
        for (const s of ['zh', 'eg', 'em']) if (saved[s]) out[s] = saved[s];
        return reply(200, { existing: !!store[key], ...out });
      }
      if (url.pathname === '/claim') {
        claims.push(body);
        await wait(250);   // saving takes a moment
        if (mode === 'conflict') return reply(409, { error: 'taken', script: 'zh', code: body.zh.code, taken: true });
        const key = body.type === 'track' ? 'track:' + body.id : 'list:' + body.items;
        const desc = (store[key] && store[key].desc) || {};
        const target = body.type === 'track' ? { type: 'track', id: body.id } : { type: 'playlist', items: body.items };
        if (body.zh && !desc.zh) desc.zh = { code: body.zh.code, chars: body.zh.chars, word: null, why: body.zh.why, saved: true };
        if (body.eg && !desc.eg) desc.eg = { code: body.eg.code, chars: [...body.eg.code].map(c => SUGGEST.eg.options.flat().find(o => o.char === c)), why: body.eg.why, saved: true };
        if (body.em && !desc.em) desc.em = { code: body.em.code, chars: [...body.em.code].map(c => ({ char: c, name: EMOJI_NAMES[c], toneable: TONEABLE.has(c) })), why: body.em.why, saved: true };
        for (const s of ['zh', 'eg', 'em']) if (body[s]) store[body[s].code] = target;
        store[key] = { desc };
        return reply(200, { existing: false, ...desc });
      }
      return reply(200, { name: { [ID1]: 'Blinding Lights', [ID2]: 'Ocean Eyes' }[url.searchParams.get('id')] || null, preview_url: null });
    });
    return ctx;
  };
  const open = async (ctx, p) => {
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + p);
    await page.waitForFunction(() => window.__calls !== undefined);
    return page;
  };
  // Copied links go out as plain ASCII (every app opens them); tests compare them decoded,
  // and every plain copy is checked for ASCII at the end
  const nonAscii = [];
  const rawClip = page => page.evaluate(() => navigator.clipboard.readText());
  const clip = async page => {
    const t = await rawClip(page);
    if (/[^\x00-\x7F]/.test(t) && !t.startsWith('[')) nonAscii.push(t);
    try { return decodeURIComponent(t); } catch (e) { return t; }
  };
  const clipHtml = page => page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return item.types.includes('text/html') ? (await item.getType('text/html')).text() : null;
  });
  // what a person sees on a card: the characters with their meanings, then the notes (not the hidden dropdown options)
  const cardText = (page, s) => page.$eval(`#sharePanel .code-card[data-script="${s}"]`, e =>
    [...e.querySelectorAll('.code-label, .char .big, .char .mean, .code-word, .code-why, .code-note, .copy-code')].map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim());
  const btn = (page, s) => page.$eval(`#sharePanel .code-card[data-script="${s}"] .copy-code`, b => [b.textContent, b.disabled]);
  const EM_SEL = n => `#sharePanel .code-card[data-script="em"] label.char:nth-of-type(${n}) select`;
  const pathNow = page => page.evaluate(() => decodeURIComponent(location.pathname));
  const rowValues = page => page.$$eval('#rows input', els => els.map(e => e.value).filter(Boolean));
  const TONE = (i, k) => `#sharePanel .tone[data-at="${i}-${k}"]`;   // swatch k (0 = default … 5 = dark) for emoji i
  const toneRows = page => page.$$eval('#sharePanel .tones', rows => rows.map(r => [...r.querySelectorAll('.tone')]
    .map(b => b.textContent + (b.getAttribute('aria-pressed') === 'true' ? '*' : '')).join(' ')).join(' | '));
  const groupLabels = page => page.$$eval('#sharePanel .tones', rows => rows.map(r => r.getAttribute('aria-label')).join('|'));

  console.log('\n### Sharing a song');
  reset();
  {
    const ctx = await newCtx();
    const page = await open(ctx, '/');
    await page.fill('#link', `https://open.spotify.com/track/${ID1}?si=abc`);
    await page.fill('#time', '1:23'); await page.fill('#endTime', '1:45');
    await page.click('text=Share as a code');
    await page.waitForSelector('#sharePanel .code-card');
    check(JSON.stringify(suggests[0]) === JSON.stringify({ type: 'track', id: ID1 }), 'Share asks the Worker for codes for this song');
    const zh = await cardText(page, 'zh'), eg = await cardText(page, 'eg');
    check(/夜 night 光 light/.test(zh) && /Neon city nights/.test(zh) && (await btn(page, 'zh'))[0] === 'Copy 夜光 link', `Chinese card: "${zh}"`);
    check(/night .* sunshine/.test(eg) && (await btn(page, 'eg'))[0] === 'Copy 𓇰𓇶 link', `hieroglyph card: "${eg}"`);
    check((await page.$$('#sharePanel select')).length === 6, 'every character on all three cards has a dropdown to swap it');
    const em = await cardText(page, 'em');
    check(/Emoji 🌃 night with stars 💡 light bulb City lights after dark Copy 🌃💡 link/.test(em), `emoji card: "${em}"`);
    await page.selectOption('#sharePanel .code-card[data-script="zh"] label.char:nth-child(2) select', '灯');
    await wait(300);
    check((await btn(page, 'zh')).join('|') === 'Copy 夜灯 link|true' && /Taken by another song/.test(await cardText(page, 'zh')), 'swapping to 夜灯 (another song has it) warns and disables copying');
    await page.selectOption('#sharePanel .code-card[data-script="zh"] label.char:nth-child(2) select', '火');
    await wait(300);
    check((await btn(page, 'zh')).join('|') === 'Copy 夜火 link|false' && /夜 night 火 fire/.test(await cardText(page, 'zh')), 'swapping to 火 updates the code and meaning');
    await page.click('#sharePanel .code-card[data-script="zh"] .copy-code');
    await wait(150);
    check(/Saving/.test(await cardText(page, 'zh')), 'shows "Saving…" while the codes save');
    await wait(500);
    check(claims.length === 1 && claims[0].zh.code === '夜火' && claims[0].eg.code === '𓇰𓇶' && claims[0].em.code === '🌃💡' && claims[0].id === ID1, 'copying saves all three codes for the song');
    check(await clip(page) === 'https://spotiky.com/夜火83-105', `clipboard: ${await clip(page)}`);
    check(await rawClip(page) === 'https://spotiky.com/%E5%A4%9C%E7%81%AB83-105', `the copied link is plain ASCII, so every app opens it: ${await rawClip(page)}`);
    check(/<a href="https:\/\/spotiky\.com\/%E5%A4%9C%E7%81%AB83-105">spotiky\.com\/夜火83-105<\/a>/.test(await clipHtml(page) || ''), `apps that keep formatting get the readable link as a link: ${await clipHtml(page)}`);
    check((await page.$$('#sharePanel select')).length === 0 && /Link copied/.test(await cardText(page, 'zh')) && /These are this song's codes/.test(await page.textContent('#sharePanel')), 'after saving the codes are fixed, and the card says the link was copied');
    await page.click('#sharePanel .code-card[data-script="eg"] .copy-code');
    await wait(200);
    check(claims.length === 1 && await clip(page) === 'https://spotiky.com/𓇰𓇶83-105', 'the hieroglyph link copies without saving again');
    await page.click('#sharePanel .code-card[data-script="em"] .copy-code');
    await wait(200);
    check(claims.length === 1 && await clip(page) === 'https://spotiky.com/🌃💡83-105', `and so does the emoji link: ${await clip(page)}`);
    await page.click('#sharePanel .code-card[data-script="em"] .copy-discord');
    await wait(200);
    check(await rawClip(page) === '[🌃💡83-105](https://spotiky.com/%F0%9F%8C%83%F0%9F%92%A183-105)' && /Copied for Discord/.test(await cardText(page, 'em')),
      `Copy for Discord gives a masked link that shows the code: ${await rawClip(page)}`);
    const discordBtns = await page.$$eval('#sharePanel .copy-discord', bs => bs.map(b => b.closest('.code-card').dataset.script).join(','));
    check(discordBtns === 'zh,eg,em', `each song code card has a Discord copy (${discordBtns})`);
    await page.fill('#link', ID2);
    check(await page.isHidden('#sharePanel'), 'changing the song closes the share card');
    await page.close();

    const page2 = await open(ctx, '/');
    await page2.fill('#link', ID1);
    await page2.click('text=Share as a code');
    await page2.waitForSelector('#sharePanel .code-card');
    check((await btn(page2, 'zh'))[0] === 'Copy 夜火 link' && (await page2.$$('#sharePanel select')).length === 0, 'sharing the same song later shows its saved codes, no dropdowns');
    await page2.fill('#link', '夜火');
    await page2.click('text=Share as a code');
    await page2.waitForSelector('#sharePanel .code-card');
    check(suggests[suggests.length - 1].id === ID1 && (await btn(page2, 'eg'))[0] === 'Copy 𓇰𓇶 link', 'a code in the link box shares that song\'s codes');
    await page2.close();
    await ctx.close();
  }
  {
    reset();
    store['track:' + ID2] = { desc: { zh: { code: '海眸', chars: [{ char: '海', meaning: 'sea' }, { char: '眸', meaning: 'eyes' }], why: 'old', saved: true },
                                      eg: { code: '𓈗𓁹', chars: [{ char: '𓈗', name: 'water' }, { char: '𓁹', name: 'eye' }], why: 'old', saved: true } } };
    const ctx = await newCtx();
    const page = await open(ctx, '/');
    await page.fill('#link', ID2);
    await page.click('text=Share as a code');
    await page.waitForSelector('#sharePanel .code-card');
    const selects = await page.$$eval('#sharePanel .code-card', cs => cs.map(c => c.dataset.script + ':' + c.querySelectorAll('select').length).join(' '));
    check(selects === 'zh:0 eg:0 em:2', `a song with older codes keeps them fixed and gets an emoji suggestion (${selects})`);
    await page.click('#sharePanel .code-card[data-script="em"] .copy-code');
    await wait(700);
    check(claims.length === 1 && claims[0].em.code === '🌃💡' && !claims[0].zh && !claims[0].eg && await clip(page) === 'https://spotiky.com/🌃💡',
      'copying the emoji link saves only the emoji code');
    await page.close(); await ctx.close();
  }
  {
    reset(); mode = 'conflict';
    const ctx = await newCtx();
    const page = await open(ctx, '/');
    await page.fill('#link', ID1);
    await page.click('text=Share as a code');
    await page.waitForSelector('#sharePanel .code-card');
    await page.evaluate(() => navigator.clipboard.writeText('untouched'));
    await page.click('#sharePanel .code-card[data-script="zh"] .copy-code');
    await wait(700);
    check(/just went to another song/.test(await cardText(page, 'zh')) && (await btn(page, 'zh'))[1] === true && await clip(page) === 'untouched', 'if someone takes the code first, it says so and copies nothing');
    mode = 'down';
    await page.click('text=Share as a code');
    await wait(400);
    check(/Codes aren't switched on yet/.test(await page.textContent('#sharePanel')), `Worker not set up: "${(await page.textContent('#sharePanel .share-error')).trim()}"`);
    await page.close(); await ctx.close();
  }

  console.log('\n### Sharing a playlist: an ID and four labels');
  {
    reset();
    const ctx = await newCtx();
    const page = await open(ctx, `/playlist/${ID1}$4-8,${ID2}`);
    await wait(300);
    await page.click('#playlistView >> text=Share as a code');
    await page.waitForSelector('#sharePanel .code-card');
    check(listSuggests.length === 1 && listSuggests[0].items === `${ID1}$4-8,${ID2}` && !listSuggests[0].auth, 'Share sends the playlist\'s songs');
    const cards = await page.$$eval('#sharePanel .code-card', cs => cs.map(c => c.dataset.script + ':' + c.querySelector('.copy-code').textContent).join(' | '));
    check(cards === 'zh:Copy k7f夜歌 link | eg:Copy k7f𓇰𓇼 link | em:Copy k7f🙌🎶 link | en:Copy k7f-night-drive link', `four labels, each after the playlist's ID: ${cards}`);
    check(/Sign in to keep one link while you edit it/.test(await page.textContent('#sharePanel .share-note')), 'signed out, the note says the link is a snapshot');
    await page.selectOption('#sharePanel .code-card[data-script="en"] label.char:nth-of-type(2) select', 'ride');
    check((await btn(page, 'en'))[0] === 'Copy k7f-night-ride link', 'English words swap like characters');
    await page.click('#sharePanel .code-card[data-script="eg"] .copy-code');
    await wait(700);
    check(listSaves.length === 1 && listSaves[0].labels.en.code === 'night-ride' && listSaves[0].labels.zh.code === '夜歌' && !listSaves[0].auth && await clip(page) === 'https://spotiky.com/playlist/k7f𓇰𓇼',
      `copying saves the whole set of labels and copies the link: ${await clip(page)}`);
    check(await pathNow(page) === '/playlist/k7f夜歌' && await page.isHidden('#ownerBar'), 'the address bar takes the short link; a snapshot has no Save bar');
    await page.close();

    const p2 = await open(ctx, '/playlist/k7f夜歌');
    await wait(500);
    check((await rowValues(p2)).join(',') === `${ID1}$4-8,${ID2}` && await pathNow(p2) === '/playlist/k7f夜歌', 'the short link opens its songs and stays in the address bar');
    await p2.fill('#rows .row:nth-child(2) input', `${ID2}$10`);
    await wait(100);
    check(await pathNow(p2) === `/playlist/${ID1}$4-8,${ID2}$10`, 'editing the songs switches to the full link');
    await p2.close(); await ctx.close();
  }

  console.log('\n### Signing in, and playlists of your own');
  {
    reset();
    const ctx = await newCtx();
    const page = await open(ctx, `/playlist/${ID1}$4-8,${ID2}`);
    await wait(300);
    check(await page.textContent('#accountBtn') === 'Sign in' && await page.isHidden('#accountPanel'), 'signed out, the header offers Sign in');
    await page.click('#accountBtn');
    await page.fill('#signInEmail', 'Me@Example.com');
    await page.click('#accountPanel >> text=Email me a code');
    await page.waitForSelector('#signInCode');
    check(authStarts[0] === 'Me@Example.com' && /Enter the code we sent to Me@Example.com/.test(await page.textContent('#accountPanel')), 'asking for a code emails one');
    await page.fill('#signInCode', '000000');
    await page.click('#accountPanel button >> text=Sign in');
    await wait(200);
    check(/That code isn't right \(4 tries left\)/.test(await page.textContent('#accountPanel')), 'a wrong code says so, with the tries left');
    await page.fill('#signInCode', '123 456');
    await page.click('#accountPanel button >> text=Sign in');
    await wait(300);
    check(await page.textContent('#accountBtn') === 'Your account' && /You're signed in/.test(await page.textContent('#accountPanel'))
      && (await page.evaluate(() => JSON.parse(localStorage.getItem('spotiky-session')).token)).startsWith('tok'), 'the right code signs in, and this browser remembers it');
    await page.click('#accountPanel .share-head button');
    await page.click('#playlistView >> text=Share as a code');
    await page.waitForSelector('#sharePanel .code-card');
    check(listSuggests[0].auth && /saves this playlist to your account/.test(await page.textContent('#sharePanel .share-note')) && (await btn(page, 'zh'))[0] === 'Copy v62夜歌 link',
      'signed in, Share says the playlist will be yours, with its own ID');
    await page.click('#sharePanel .code-card[data-script="zh"] .copy-code');
    await wait(700);
    check(listSaves[0].auth && listSaves[0].id === 'v62' && listSaves[0].idSig === 'sig' && await clip(page) === 'https://spotiky.com/playlist/v62夜歌', `copying saves it as yours: ${await clip(page)}`);
    check(await pathNow(page) === '/playlist/v62夜歌' && await page.isVisible('#ownerBar') && await page.isDisabled('#saveListBtn'), 'the Save changes bar appears, with nothing to save yet');
    await page.fill('#rows .row:nth-child(2) input', `${ID2}$30`);
    await wait(200);
    check(!(await page.isDisabled('#saveListBtn')) && await pathNow(page) === `/playlist/${ID1}$4-8,${ID2}$30`, 'changing a song turns Save changes on');
    await page.click('#saveListBtn');
    await wait(400);
    check(listSaves[1].edit === 'v62' && listSaves[1].items === `${ID1}$4-8,${ID2}$30` && await pathNow(page) === '/playlist/v62夜歌' && /^Saved\./.test(await page.textContent('#status'))
      && await page.isDisabled('#saveListBtn'), `Save changes keeps the same link: "${await page.textContent('#status')}"`);
    await page.click('#accountBtn');
    await wait(300);
    check(/spotiky\.com\/playlist\/v62夜歌 · 2 songs/.test(await page.textContent('#accountPanel')), 'Your account lists your playlists');
    await page.close();

    const p2 = await open(ctx, '/playlist/v62夜歌');
    await wait(500);
    check((await rowValues(p2)).join(',') === `${ID1}$4-8,${ID2}$30` && await p2.isVisible('#ownerBar'), 'opening the link later shows the edited songs, still yours to edit');
    await p2.close();
    const ctx2 = await newCtx();
    const p3 = await open(ctx2, '/playlist/v62夜歌');
    await wait(500);
    check((await rowValues(p3)).join(',') === `${ID1}$4-8,${ID2}$30` && await p3.isHidden('#ownerBar'), 'anyone else gets the same songs and no Save bar');
    await p3.close(); await ctx2.close();
    const p4 = await open(ctx, '/playlist/v62夜歌');
    await wait(400);
    await p4.click('#accountBtn');
    await p4.click('#accountPanel >> text=Sign out');
    await wait(300);
    check(await p4.textContent('#accountBtn') === 'Sign in' && await p4.isHidden('#ownerBar') && !(await p4.evaluate(() => localStorage.getItem('spotiky-session'))),
      'signing out hides the Save bar and forgets the sign-in');
    await p4.close(); await ctx.close();
  }

  console.log('\n### Skin tones');
  {
    reset();
    const ctx = await newCtx();
    const page = await open(ctx, '/');
    await page.fill('#link', ID1); await page.fill('#time', '30');
    await page.click('text=Share as a code');
    await page.waitForSelector('#sharePanel .code-card');
    check(!(await page.$('#sharePanel .tone')) && !/skin tone/i.test(await page.textContent('#sharePanel')), 'no skin tones offered when the emoji code has no people or hands (🌃💡)');
    await page.selectOption(EM_SEL(1), '💃');
    await wait(300);
    check(await toneRows(page) === '💃* 💃🏻 💃🏼 💃🏽 💃🏾 💃🏿', `swapping in 💃 offers six skin tones, default chosen: ${await toneRows(page)}`);
    check(/Any skin tone opens the same song\./.test(await page.textContent('#sharePanel .share-note')), 'the note says any tone opens the same song');
    await page.click(TONE(0, 4));
    const em = await cardText(page, 'em');
    const focused = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));
    check(/💃🏾 woman dancing 💡 light bulb/.test(em) && (await btn(page, 'em'))[0] === 'Copy 💃🏾💡 link' && focused === 'Medium-dark skin tone',
      `medium-dark shows 💃🏾, focus stays on the swatch (${focused}): "${em}"`);
    const optText = await page.$eval(EM_SEL(1), s => [...s.options].map(o => o.textContent.split(' ')[0]).join(''));
    check(optText === '🌃🌙💃🏾🕺🏾', `the dropdown shows people in the tone picked for that place: ${optText}`);
    await page.selectOption(EM_SEL(2), '🙌');
    await wait(300);
    check(await toneRows(page) === '💃 💃🏻 💃🏼 💃🏽 💃🏾* 💃🏿 | 🙌 🙌🏻 🙌🏼 🙌🏽 🙌🏾* 🙌🏿' && await groupLabels(page) === 'Skin tone for woman dancing|Skin tone for raising hands',
      `a second person or hand gets its own row, starting in the last tone picked: ${await toneRows(page)}`);
    await page.click(TONE(1, 1));
    check((await btn(page, 'em'))[0] === 'Copy 💃🏾🙌🏻 link' && await toneRows(page) === '💃 💃🏻 💃🏼 💃🏽 💃🏾* 💃🏿 | 🙌 🙌🏻* 🙌🏼 🙌🏽 🙌🏾 🙌🏿',
      `each emoji keeps its own tone: ${(await btn(page, 'em'))[0]}`);
    await page.click('#sharePanel .code-card[data-script="em"] .copy-code');
    await wait(700);
    check(claims.length === 1 && claims[0].em.code === '💃🙌' && await clip(page) === 'https://spotiky.com/💃🏾🙌🏻30',
      `the code is saved without tones (${claims[0] && claims[0].em.code}) and the link keeps both: ${await clip(page)}`);
    await page.click(TONE(0, 0));
    await page.click('#sharePanel .code-card[data-script="em"] .copy-code');
    await wait(200);
    check(claims.length === 1 && await clip(page) === 'https://spotiky.com/💃🙌🏻30', `once saved, any mix of tones copies without saving again: ${await clip(page)}`);
    await page.click(TONE(0, 4));   // this browser's picks end as 💃 medium-dark, 🙌 light
    check(codeReqs.length > 0 && !codeReqs.some(c => TONE_RE.test(c)), `codes are always looked up without tones (${codeReqs.join(' ')})`);
    await page.close();

    const p2 = await open(ctx, '/');
    await p2.fill('#link', ID1);
    await p2.click('text=Share as a code');
    await p2.waitForSelector('#sharePanel .code-card');
    check((await btn(p2, 'em'))[0] === 'Copy 💃🏾🙌🏻 link' && (await p2.$$('#sharePanel select')).length === 0,
      `the browser remembers each emoji's tone, and saved codes still take tones: ${(await btn(p2, 'em'))[0]}`);
    await p2.fill('#link', ID2);
    await p2.click('text=Share as a code');
    await p2.waitForSelector('#sharePanel .code-card'); await wait(200);
    await p2.selectOption(EM_SEL(1), '🕺');
    await wait(300);
    check((await btn(p2, 'em'))[0] === 'Copy 🕺🏾💡 link', `an emoji never toned here starts in the last tone picked: ${(await btn(p2, 'em'))[0]}`);
    await p2.close();

    codeReqs = [];
    const p3 = await open(ctx, '/💃🏿🙌🏼30');
    await p3.waitForFunction(() => window.__calls.some(c => c.load));
    const load = await p3.evaluate(() => window.__calls.find(c => c.load));
    check(load.load === ID1 && load.at === 30 && codeReqs.join() === '💃🙌', `a link with other tones opens the same song (lookup: ${codeReqs.join()})`);
    await p3.click('text=Share as a code');
    await p3.waitForSelector('#sharePanel .code-card');
    await p3.click('#sharePanel .code-card[data-script="em"] .copy-code'); await wait(200);
    const kept = await p3.evaluate(() => JSON.parse(localStorage.getItem('spotiky-skin-tones')));
    check(await clip(p3) === 'https://spotiky.com/💃🏿🙌🏼30' && kept['💃'] === '\u{1F3FE}' && kept['🙌'] === '\u{1F3FB}',
      `re-sharing a toned link keeps its tones (${await clip(p3)}) and leaves this browser's own picks alone`);
    await p3.close();
    await ctx.close();
  }
  {
    reset();
    const items = `💃💡,${ID2}`;
    store['💃💡'] = { type: 'track', id: ID1 };
    playlists.k7f = { id: 'k7f', items, owner: null, labels: { zh: { code: '夜歌' }, em: { code: '🙌🎶' }, en: { code: 'night-drive' } } };
    const ctx = await newCtx();
    const page = await open(ctx, `/playlist/💃🏽💡,${ID2}`);
    await wait(400);
    await page.click('#playlistView >> text=Share as a code');
    await page.waitForSelector('#sharePanel .code-card');
    await page.click('#sharePanel .code-card[data-script="em"] .copy-code'); await wait(300);
    check(listSuggests[0].items === items && await clip(page) === 'https://spotiky.com/playlist/k7f🙌🎶' && /Any skin tone opens the same playlist/.test(await page.textContent('#sharePanel .share-note')),
      `songs in other tones make the same playlist, with the same links: ${listSuggests[0].items.replace(ID2, 'ID2')} -> ${await clip(page)}`);
    await page.close();
    const p2 = await open(ctx, '/playlist/k7f🙌🏿🎶');
    await wait(500);
    check((await rowValues(p2)).join(',') === `💃💡,${ID2}` && await pathNow(p2) === '/playlist/k7f🙌🏿🎶', 'a short link in any skin tone opens its songs, and the address bar keeps the tone');
    await p2.click('#playlistView >> text=Share as a code');
    await p2.waitForSelector('#sharePanel .code-card');
    await p2.click('#sharePanel .code-card[data-script="em"] .copy-code'); await wait(300);
    check(await clip(p2) === 'https://spotiky.com/playlist/k7f🙌🏿🎶', `re-sharing it keeps the tone: ${await clip(p2)}`);
    await p2.close(); await ctx.close();
  }

  console.log('\n### Spotiky links in the song box');
  {
    reset();
    const ctx = await newCtx();
    const page = await open(ctx, '/');
    await page.fill('#link', `https://spotiky.com/track/${ID1}$1:23-1:45`);
    await page.click('text=Share as a code');
    await page.waitForSelector('#sharePanel .code-card');
    await page.click('#sharePanel .code-card[data-script="zh"] .copy-code'); await wait(700);
    check(suggests[0].id === ID1 && await clip(page) === 'https://spotiky.com/夜光83-105', `sharing a Spotiky clip link keeps the clip: ${await clip(page)}`);
    playlists.k7f = { id: 'k7f', items: `${ID1}$4-8,${ID2}`, owner: null, labels: { zh: { code: '夜歌' }, eg: { code: '𓇰𓇼' } } };
    await page.fill('#link', 'https://spotiky.com/playlist/k7f夜歌');
    await Promise.all([page.waitForURL(/\/playlist\//), page.click('text=Share as a code')]);
    await page.waitForSelector('#sharePanel .code-card');
    check(listSuggests.length === 1 && listSuggests[0].items === `${ID1}$4-8,${ID2}` && decodeURIComponent(new URL(page.url()).pathname) === '/playlist/k7f夜歌' && !page.url().includes('#share'),
      'Share with a playlist\'s short link opens the playlist page, its share card open');
    await page.close(); await ctx.close();
  }

  if (SHOTS) {   // one look at the card on a phone
    reset();
    const ctx = await newCtx({ width: 390, height: 844 });
    const page = await open(ctx, '/');
    await page.addStyleTag({ content: `@font-face{font-family:'Noto Sans Egyptian Hieroglyphs';src:url(data:font/woff2;base64,${fs.readFileSync(process.argv[4]).toString('base64')}) format('woff2');}` });
    await page.fill('#link', ID1); await page.fill('#time', '1:23'); await page.fill('#endTime', '1:45');
    await page.click('text=Share as a code');
    await page.waitForSelector('#sharePanel .code-card');
    await page.selectOption('#sharePanel .code-card[data-script="zh"] label.char:nth-child(2) select', '灯');
    await wait(400);
    await page.selectOption(EM_SEL(1), '💃'); await wait(300);
    await page.click(TONE(0, 4));
    await page.selectOption(EM_SEL(2), '🙌'); await wait(300);
    await page.click(TONE(1, 2));
    await page.evaluate(() => document.activeElement.blur());
    await page.mouse.move(0, 0);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth);
    check(wide <= 390, `no sideways scrolling on a phone (${wide}px wide)`);
    await page.locator('#sharePanel').screenshot({ path: SHOTS });
    await page.close();

    // Signing in, then a playlist of your own: its four links and the Save bar
    const font = `@font-face{font-family:'Noto Sans Egyptian Hieroglyphs';src:url(data:font/woff2;base64,${fs.readFileSync(process.argv[4]).toString('base64')}) format('woff2');}`;
    const p2 = await open(ctx, `/playlist/${ID1}$4-8,${ID2}`);
    await p2.addStyleTag({ content: font });
    await wait(300);
    await p2.click('#accountBtn');
    await p2.fill('#signInEmail', 'me@example.com');
    await p2.click('#accountPanel >> text=Email me a code');
    await p2.waitForSelector('#signInCode');
    await p2.fill('#signInCode', '123456');
    await p2.evaluate(() => document.activeElement.blur());
    await p2.screenshot({ path: SHOTS.replace('.png', '-signin.png'), clip: { x: 0, y: 0, width: 390, height: 520 } });
    slowVerify = true;
    const checksBefore = verifies.length;
    await p2.click('#accountPanel button >> text=Sign in');
    await wait(300);
    const midway = await p2.textContent('#accountPanel');
    await p2.click('#accountPanel button >> text=Sign in').catch(() => {});   // an impatient second click
    await p2.waitForFunction(() => document.getElementById('accountBtn').textContent === 'Your account', null, { timeout: 8000 }).catch(() => {});
    slowVerify = false;
    check(/Checking…/.test(midway) && verifies.length - checksBefore === 1 && /You're signed in/.test(await p2.textContent('#accountPanel')),
      `a slow code check says Checking… right away, a second click sends nothing, then it signs in (${verifies.length - checksBefore} check sent)`);
    await p2.click('#accountPanel .share-head button');
    await p2.click('#playlistView >> text=Share as a code');
    await p2.waitForSelector('#sharePanel .code-card');
    await p2.click(TONE(0, 3));
    await p2.click('#sharePanel .code-card[data-script="zh"] .copy-code');
    await wait(700);
    await p2.fill('#rows .row:nth-child(2) input', `${ID2}$30`);
    await wait(300);
    await p2.evaluate(() => document.activeElement.blur());
    await p2.mouse.move(0, 0);
    const wide2 = await p2.evaluate(() => document.documentElement.scrollWidth);
    check(wide2 <= 390, `the playlist page with sign-in fits a phone too (${wide2}px wide)`);
    await p2.locator('#sharePanel').screenshot({ path: SHOTS.replace('.png', '-playlist.png') });
    const top = await p2.locator('#ownerBar').evaluate(e => e.getBoundingClientRect().top + window.scrollY);
    await p2.screenshot({ path: SHOTS.replace('.png', '-owner.png'), fullPage: true, clip: { x: 0, y: Math.max(0, top - 150), width: 390, height: 330 } });
    await p2.close(); await ctx.close();
  }
  check(nonAscii.length === 0, `every copied link was plain ASCII${nonAscii.length ? ': ' + nonAscii.join(' ') : ''}`);
  console.log(`\n${pass} passed, ${fail} failed${errors.length ? '; PAGE ERRORS: ' + [...new Set(errors)].join(' | ') : '; no page errors'}`);
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
