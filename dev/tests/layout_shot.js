// Phone screenshots of the top of the song page and the playlist page (what fits without scrolling)
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = process.argv[2], OUT = process.argv[3];
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split(/[?#]/)[0]);
  const fp = path.join(ROOT, p === '/' ? 'index.html' : p.slice(1));
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) { res.writeHead(200, { 'Content-Type': /\.js$/.test(fp) ? 'application/javascript' : 'text/html' }); return res.end(fs.readFileSync(fp)); }
  res.writeHead(404, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(ROOT, '404.html')));
});
const FAKE_API = `(function(){const ctrl={loadEntity(){},play(){},pause(){},addListener(){}};window.onSpotifyIframeApiReady({createController(e,o,cb){e.style.cssText='height:152px;background:#2a2a2a;border-radius:12px';cb(ctrl);}});})();`;
(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(base)) return route.continue();
    if (u.includes('/embed/iframe-api/')) return route.fulfill({ contentType: 'application/javascript', body: FAKE_API });
    return route.fulfill({ status: 404, body: '' });
  });
  for (const [p, name] of [['/', 'track'], ['/playlist', 'playlist']]) {
    const page = await ctx.newPage();
    await page.goto(base + p); await page.waitForTimeout(500);
    const info = await page.evaluate(() => {
      const top = sel => { const e = document.querySelector(sel); if (!e || e.hidden || !e.offsetParent) return null; return Math.round(e.getBoundingClientRect().top); };
      return { linkBox: top('#link'), firstRow: top('#rows input'), hint: top('#trackHint') ?? top('#playlistHint'), notes: top('#topNotes'), pageHeight: document.documentElement.scrollHeight, wide: document.documentElement.scrollWidth };
    });
    console.log(name, JSON.stringify(info));
    await page.screenshot({ path: `${OUT}-${name}.png` });
    await page.close();
  }
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
