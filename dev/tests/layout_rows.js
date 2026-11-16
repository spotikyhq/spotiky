const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = process.argv[2];
const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fs.readFileSync(path.join(ROOT, 'index.html'))); });
(async () => {
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  for (const [w, hgt] of [[360, 640], [390, 664]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, isMobile: true, hasTouch: true });
    await ctx.route('**/*', r => r.request().url().startsWith(base) ? r.continue() : r.fulfill({ status: 404, body: '' }));
    const page = await ctx.newPage(); await page.goto(base + '/'); await page.waitForTimeout(300);
    console.log(w + 'x' + hgt, JSON.stringify(await page.evaluate(() => {
      const out = {};
      for (const [k, sel] of Object.entries({ header: '.top', h1: 'h1', btn: '#accountBtn', subtitle: '#subtitle', notes: '#trackHint', link: '#link', times: '#times', play: '#trackView > button', status: '#status', embed: '#embed' })) {
        const r = document.querySelector(sel).getBoundingClientRect(); out[k] = `${Math.round(r.top)}-${Math.round(r.bottom)}`;
      }
      out.h1font = getComputedStyle(document.querySelector('h1')).fontSize; out.bodyPad = getComputedStyle(document.body).paddingTop;
      return out;
    })));
    await ctx.close();
  }
  await browser.close(); server.close();
})();
