// Pages opened on the old workers.dev address move to app.mutosstudio.com, keeping path, ?query and the #sign-in tokens.
// Run: node tests/home-address.test.js
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', 'public');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const b = await chromium.launch(), ctx = await b.newContext();
  await ctx.route(/cdn\.jsdelivr\.net|fonts\.googleapis|fonts\.gstatic|supabase\.co/, r => r.abort());
  // the old address serves the real pages; the new address answers with a marker page
  await ctx.route(/^https:\/\/mutos-app\.someone\.workers\.dev\//, r => {
    let p = new URL(r.request().url()).pathname; if (p === '/') p = '/index.html';
    const f = path.join(ROOT, p); if (!fs.existsSync(f)) return r.fulfill({ status: 404, body: '' });
    r.fulfill({ status: 200, contentType: p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(f) });
  });
  await ctx.route(/^https:\/\/app\.mutosstudio\.com\//, r => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>new</title>new address' }));
  const page = await ctx.newPage();
  for (const p of ['/', '/crew.html?preview=1', '/board.html#board', '/#access_token=abc&refresh_token=def&token_type=bearer', '/client.html?k=123', '/gear.html', '/desk.html', '/mywork.html', '/work.html', '/attendance.html', '/office.html']) {
    await page.goto('https://mutos-app.someone.workers.dev' + p); await page.waitForURL(/app\.mutosstudio\.com/, { timeout: 5000 }).catch(() => {});
    ok(page.url() === 'https://app.mutosstudio.com' + p, p + ' → ' + page.url());
  }
  await b.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
