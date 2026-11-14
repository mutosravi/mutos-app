// Phones: tapping a box must not zoom the page, and no browser suggestions under the boxes (14 Nov 2026, Ravi).
// public/app.css (16px boxes on touch screens) + public/config.js (autocomplete off). Run: node tests/phone-inputs.test.js
const fs = require('fs'), path = require('path'); const { chromium, devices } = require('playwright');
process.chdir(path.resolve(__dirname, '..'));
const css = fs.readFileSync('public/app.css', 'utf8'), cfg = fs.readFileSync('public/config.js', 'utf8');
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css + '</style><style>.small{font-size:13px}</style></head><body>' +
  '<input class="in small" id="a"><input class="in" id="b" style="font-size:12px"><select id="c" class="small"><option>x</option></select><textarea id="d" class="small"></textarea>' +
  '<input class="in codein" id="code" autocomplete="one-time-code" style="font:700 30px sans-serif"><input type="checkbox" id="e"><script>' + cfg + '</script></body></html>';
(async () => {
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  const b = await chromium.launch();
  const size = (p, id) => p.$eval('#' + id, el => parseFloat(getComputedStyle(el).fontSize));
  const ph = await (await b.newContext(devices['iPhone 13'])).newPage(); await ph.setContent(html);
  ok(await size(ph, 'a') === 16 && await size(ph, 'b') === 16 && await size(ph, 'c') === 16 && await size(ph, 'd') === 16, 'phone: every box is 16px (no zoom on tap), also over a size written on the box itself');
  ok(await size(ph, 'code') === 30, 'phone: the big office-code box keeps its 30px');
  ok(await ph.getAttribute('#a', 'autocomplete') === 'off' && await ph.getAttribute('#d', 'autocomplete') === 'off' && await ph.getAttribute('#code', 'autocomplete') === 'one-time-code', 'no browser suggestions (boxes that ask for one keep it)');
  await ph.evaluate(() => { const f = document.createElement('div'); f.innerHTML = '<input id="late"><textarea id="late2"></textarea>'; document.body.appendChild(f); });
  await ph.waitForTimeout(50);
  ok(await ph.getAttribute('#late', 'autocomplete') === 'off' && await ph.getAttribute('#late2', 'autocomplete') === 'off', '… also on forms drawn later (sheets, windows)');
  const pc = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); await pc.setContent(html);
  ok(await size(pc, 'a') === 13, 'computer: sizes stay as designed');
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
