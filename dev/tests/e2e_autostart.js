// Does a timestamp link start playing when Spotify's player script is ready before the page's own
// script runs? The stand-in calls onSpotifyIframeApiReady once, like Spotify's, and never again.
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const PAGE = process.argv[2];   // the index.html to test
const ID = '7gaA3wERFkFkgivjwbSvkG';
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(PAGE)); });
const STRICT_API = `(function(){window.__calls=window.__calls||[];const ctrl={loadEntity(u,v,a){window.__calls.push({load:u.split(':').pop(),at:a});},play(){window.__calls.push({play:true});},pause(){},addListener(){}};
if (typeof window.onSpotifyIframeApiReady === 'function') window.onSpotifyIframeApiReady({createController(e,o,cb){setTimeout(()=>cb(ctrl),50);}});})();`;
let pass = 0, fail = 0;
const check = (ok, line) => { ok ? pass++ : fail++; console.log((ok ? 'ok   ' : 'FAIL ') + line); };
(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const [fontDelay, apiDelay, label] of [[1500, 0, 'slow font, fast Spotify script'], [0, 300, 'fast font, slower Spotify script'], [0, 0, 'both fast']]) {
    const ctx = await browser.newContext();
    await ctx.route('**/*', async route => {
      const u = route.request().url();
      if (u.startsWith(base)) return route.continue();
      if (u.includes('fonts.googleapis.com')) { await new Promise(r => setTimeout(r, fontDelay)); return route.fulfill({ contentType: 'text/css', body: '/* font */' }); }
      if (u.includes('/embed/iframe-api/')) { await new Promise(r => setTimeout(r, apiDelay)); return route.fulfill({ contentType: 'application/javascript', body: STRICT_API }); }
      return route.fulfill({ contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{"name":null}' });
    });
    const page = await ctx.newPage();
    await page.goto(`${base}/track/${ID}$83`, { waitUntil: 'commit' });
    await page.waitForTimeout(fontDelay + apiDelay + 1500);
    const calls = await page.evaluate(() => window.__calls || []);
    const load = calls.find(c => c.load);
    check(load && load.load === ID && load.at === 83, `${label.padEnd(33)} -> ${load ? `started at ${load.at}s` : 'never started; status: ' + await page.textContent('#status')}`);
    await ctx.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
