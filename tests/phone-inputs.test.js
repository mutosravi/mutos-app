// Phones: tapping a box must not zoom the page; suggestions show UNDER the box (the app's own list, not the browser's above the
// keyboard) and hide on a tap elsewhere (14 Nov 2026, Ravi). public/app.css (16px boxes on touch screens) + public/config.js. Run: node tests/phone-inputs.test.js
const fs = require('fs'), path = require('path'); const { chromium, devices } = require('playwright');
process.chdir(path.resolve(__dirname, '..'));
const css = fs.readFileSync('public/app.css', 'utf8'), cfg = fs.readFileSync('public/config.js', 'utf8');
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>' + css + '</style><style>.small{font-size:13px}</style></head><body>' +
  '<input class="in small" id="a"><input class="in" id="b" style="font-size:12px"><select id="c" class="small"><option>x</option></select><textarea id="d" class="small"></textarea>' +
  '<p id="blank" style="height:200px">blank</p><input id="venue" list="vl"><datalist id="vl"><option value="Taj Mahal Hotel"><option value="Clarks Avadh"><option value="Taj Palace"></datalist><input id="cam"><input type="search" id="sq"><span id="got"></span>' +
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
  // suggestions under the box
  await ph.evaluate(() => document.getElementById('venue').addEventListener('change', e => { document.getElementById('got').textContent = e.target.value; }));
  await ph.tap('#venue'); await ph.waitForSelector('#mutos-suggest:not([hidden]) [data-i]');
  const g = await ph.evaluate(() => { const r = document.getElementById('venue').getBoundingClientRect(), s = document.getElementById('mutos-suggest').getBoundingClientRect(); return { inTop: r.top, inBottom: r.bottom, sTop: s.top, n: document.querySelectorAll('#mutos-suggest [data-i]').length, list: document.getElementById('venue').getAttribute('list') }; });
  ok(g.n === 3 && g.sTop >= g.inBottom && g.sTop - g.inBottom < 10 && !g.list, 'tapping a box with a list: the suggestions open right UNDER the box (the browser\'s own list, shown above the keyboard, is off)');
  await ph.type('#venue', 'taj'); await ph.waitForTimeout(50);
  ok(await ph.$$eval('#mutos-suggest [data-i]', l => l.map(x => x.textContent).join('|')) === 'Taj Mahal Hotel|Taj Palace', 'typing narrows them (taj → Taj Mahal Hotel, Taj Palace)');
  await ph.tap('#mutos-suggest [data-i="1"]');
  ok(await ph.inputValue('#venue') === 'Taj Palace' && await ph.textContent('#got') === 'Taj Palace' && await ph.isHidden('#mutos-suggest'), 'tap a suggestion: it fills the box (the page hears the change) and the list closes');
  await ph.fill('#venue', ''); await ph.tap('#venue'); await ph.waitForSelector('#mutos-suggest:not([hidden])');
  await ph.tap('#blank'); await ph.waitForTimeout(50);
  ok(await ph.isHidden('#mutos-suggest'), 'tap on blank space: the list hides');
  // what was typed before in the same box comes back as a suggestion
  await ph.tap('#cam'); await ph.fill('#cam', 'Z9 Saif'); await ph.tap('#blank'); await ph.waitForTimeout(50);
  await ph.fill('#cam', ''); await ph.tap('#cam'); await ph.waitForSelector('#mutos-suggest:not([hidden])');
  ok(await ph.textContent('#mutos-suggest') === 'Z9 Saif', 'a plain box suggests what was typed in it before (kept on this phone)');
  await ph.tap('#blank'); await ph.tap('#sq'); await ph.waitForTimeout(50);
  ok(await ph.isHidden('#mutos-suggest'), 'search boxes get no suggestions');
  const pc = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage(); await pc.setContent(html);
  ok(await size(pc, 'a') === 13, 'computer: sizes stay as designed');
  ok(await pc.getAttribute('#venue', 'list') === 'vl' && await pc.getAttribute('#a', 'autocomplete') === null, 'computer: the browser\'s own list under the box, as before');
  await b.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
