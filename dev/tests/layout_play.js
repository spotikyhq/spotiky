// Where the Spotify player lands once a song plays, on common screen sizes (visible area,
// without browser bars). Prints whether the whole player fits without scrolling.
//   node layout_play.js ROOT OUT_PREFIX
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = process.argv[2], OUT = process.argv[3];
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split(/[?#]/)[0]);
  const fp = path.join(ROOT, p === '/' ? 'index.html' : p.slice(1));
  if (fs.existsSync(fp) && fs.statSync(fp).isFile()) { res.writeHead(200, { 'Content-Type': /\.js$/.test(fp) ? 'application/javascript' : 'text/html' }); return res.end(fs.readFileSync(fp)); }
  res.writeHead(404, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(ROOT, '404.html')));
});
// A stand-in Spotify player that reports "playing" once a song loads, like the real one
const FAKE_API = `(function(){let cb=null;const ctrl={loadEntity(){},play(){setTimeout(()=>cb&&cb({data:{position:1000,duration:200000,isPaused:false}}),50)},
  pause(){},resume(){},seek(){},togglePlay(){},addListener(ev,f){if(ev==='playback_update')cb=f;if(ev==='ready')setTimeout(f,0)}};
  const start=api=>api;window.onSpotifyIframeApiReady&&window.onSpotifyIframeApiReady({createController(e,o,done){
  const f=document.createElement('iframe');f.id=e.id;f.style.cssText='width:100%;height:152px;border:0;background:#2a2a2a;border-radius:12px;display:block';
  e.replaceWith(f);done(ctrl);}});})();`;
const SIZES = [
  ['iPhone, Safari bars', 390, 664],
  ['Android, Chrome bar', 412, 760],
  ['small Android', 360, 640],
  ['laptop 1366x768', 1366, 657],
  ['laptop 1440x900', 1440, 789],
];
(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const [name, width, height] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: name.startsWith('iPhone') ? 2 : 1, isMobile: width < 500, hasTouch: width < 500 });
    await ctx.route('**/*', route => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      if (u.includes('/embed/iframe-api/')) return route.fulfill({ contentType: 'application/javascript', body: FAKE_API });
      return route.fulfill({ status: 404, body: '' });
    });
    const page = await ctx.newPage();
    await page.goto(base + '/'); await page.waitForTimeout(400);
    await page.fill('#link', 'https://open.spotify.com/track/7gaA3wERFkFkgivjwbSvkG');
    await page.fill('#time', '1:23');
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /^Play/.test(x.textContent)); b.click(); });
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => {
      const box = sel => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
      return { player: box('#embed'), marks: box('.times.marking .mark'), status: document.getElementById('status').textContent, scrollY: Math.round(scrollY), wide: document.documentElement.scrollWidth };
    });
    const fits = info.player && info.player.bottom <= height && info.player.top >= 0;
    console.log(`${fits ? 'FITS     ' : 'SCROLL   '} ${name.padEnd(20)} ${width}x${height}  player ${info.player ? info.player.top + '-' + info.player.bottom : 'none'}  Now buttons ${info.marks ? 'shown' : 'hidden'}  scrolled ${info.scrollY}px  status "${info.status}"  widest ${info.wide}`);
    if (OUT) await page.screenshot({ path: `${OUT}-${width}x${height}.png` });
    await ctx.close();
  }
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
