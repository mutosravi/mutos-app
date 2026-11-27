// Settings → Photos on Google Drive: the "Move them into this Drive" part (public/photos.js), with the Worker faked.
// Run: node tests/photos-settings.test.js
const path = require('path'), fs = require('fs'); const { chromium } = require('playwright');
(async () => {
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  const b = await chromium.launch(), p = await b.newPage(), errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('dialog', d => d.accept());
  let moved = 0, forgot = false, oldOn = true;
  await p.route('https://app.test/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body><script src="/photos.js"></script></body>' });
    if (u.pathname === '/photos.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(__dirname, '../public/photos.js'), 'utf8') });
    if (u.pathname === '/api/photos/status') return route.fulfill({ json: { configured: true, connected: true, account: 'new.studio@gmail.com', old: oldOn ? { account: 'old.studio@gmail.com' } : undefined } });
    if (u.pathname === '/api/photos/move') { const off = JSON.parse(route.request().postData()).offset; moved++; return route.fulfill({ json: { moved: off < 6 ? 3 : 1, already: 0, missing: 0, total: 7, next: Math.min(off + 3, 7), done: off + 3 >= 7 } }); }
    if (u.pathname === '/api/photos/forget-old') { forgot = true; oldOn = false; return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ status: 404, body: '' });
  });
  await p.goto('https://app.test/');
  await p.evaluate(() => window.MutosPhotos.settings({ auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } }));
  await p.waitForSelector('#gd-mv');
  ok(/old\.studio@gmail\.com/.test(await p.textContent('#gd-mv')) && /Connect a different Gmail/.test(await p.textContent('#gd-win')) && /not Disconnect/.test(await p.textContent('#gd-body')), 'Settings: the earlier Gmail\'s photos are named, with "Move them into this Drive", and how to switch Gmail');
  await p.click('#gd-mv-go'); await p.waitForSelector('#gd-forget', { timeout: 10000 });
  ok(moved === 3 && /7 of 7 checked · 7 moved/.test(await p.textContent('#gd-mv-st')) && /Done/.test(await p.textContent('#gd-mv-st')), 'Move goes on in pieces until all 7 are checked, then says Done');
  await p.click('#gd-forget'); await p.waitForFunction(() => !document.getElementById('gd-mv'));
  ok(forgot, '"Forget old.studio@gmail.com" tells the server and hides the part');
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
