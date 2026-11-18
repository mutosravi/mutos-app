// Gear 'not available' dates: Manage gear form, conflicts on shoots, greyed in pickers, sent to the Gear desk.
// Run: node tests/gear-off.test.js <backup.json>
const path = require('path'), fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));
// reuse load-backup test's fake by loading data first, then poking at undo
const http = require('http'); const { chromium } = require('playwright');
const ROOT = path.resolve('public'); const OWNER = 'o@x.com';
const docs = new Map(); const sleep = ms => new Promise(r => setTimeout(r, ms));
const bk = JSON.parse(fs.readFileSync(process.argv[2]));
bk.events.forEach(e => docs.set('events/' + e.id, { collection: 'events', id: e.id, data: e }));
bk.shooters.forEach(e => docs.set('shooters/' + e.id, { collection: 'shooters', id: e.id, data: e }));
bk.equipment.forEach(e => docs.set('gear/' + e.id, { collection: 'gear', id: e.id, data: e }));
const members = new Map([[OWNER, { email: OWNER, role: 'owner' }]]);
let rt = null;
async function handle(d) {
  if (d.op === 'session') return { id: 'u1', email: OWNER, user_metadata: {} };
  await sleep(60);
  const t = d.table === 'docs' ? docs : d.table === 'members' ? members : new Map();
  const match = r => d.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v : op === 'gte' ? String(r[c]) >= v : v.includes(r[c]));
  if (d.op === 'select') { let rows = [...t.values()].filter(match); if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1); return { data: d.single ? rows[0] || null : rows, error: null }; }
  if (d.op === 'upsert') { d.rows.forEach(r => { const k = d.table === 'docs' ? r.collection + '/' + r.id : (r.email || r.person_key); t.set(k, r); if (d.table === 'docs') setTimeout(() => rt && rt({ eventType: 'UPDATE', new: r, old: {} }), 300); }); return { data: null, error: null }; }
  if (d.op === 'delete') { [...t.entries()].forEach(([k, r]) => { if (match(r)) t.delete(k); }); return { data: null, error: null }; }
  return { data: null, error: null };
}
const server = http.createServer((q, s) => { let p = q.url.split('?')[0]; if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(s); });
(async () => {
  await new Promise(r => server.listen(8793, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d));
  await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8'));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  await p.goto('http://localhost:8793/board.html#board');
  await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });
  // a shoot where someone carries an item, and another shoot the same day
  const pick = await p.evaluate(() => {
    const st = window.__boardApi.state();
    const today = window.__boardApi.todayStr();
    for (const ev of st.events) { if (ev.date < today) continue; const a = ev.assignments.find(x => x.memberId && x.gearIds.length); if (!a) continue;
      const other = st.events.find(o => o.id !== ev.id && o.date === ev.date && o.assignments.some(x => x.memberId));
      if (other) { const gid = a.gearIds[0]; const eq = st.equipment.find(e => e.id === gid); return { ev: ev.id, evName: ev.name, date: ev.date, gid, gname: eq.name, other: other.id }; } }
    return null; });
  ok(!!pick, 'found a shoot with gear and another shoot that day: ' + (pick && pick.gname + ' on ' + pick.date));
  // mark it not available through Manage gear
  await p.click('#sb-manage-gear'); await p.waitForSelector('.sb-modal');
  const opened = await p.evaluate(name => { const row = [...document.querySelectorAll('.sb-manage-row')].find(r => { const n = r.querySelector('.sb-manage-name'); return n && n.firstChild && n.firstChild.textContent.trim() === name; }); if (!row) return false; row.querySelector('.act-na').click(); return true; }, pick.gname);
  ok(opened, 'every gear item has a "not available" button');
  await p.waitForSelector('.na-from');
  await p.fill('.na-from', pick.date); await p.dispatchEvent('.na-from', 'change');
  await p.fill('.na-why', 'Vendor out of stock');
  await p.click('.na-add'); await sleep(1200);
  const toastTxt = await p.textContent('#sb-toast');
  ok(/not available on 1 day/.test(toastTxt) && /Already on a shoot/.test(toastTxt), 'toast warns it is already on a shoot: ' + toastTxt.slice(0, 120));
  const eqDoc = docs.get('gear/' + pick.gid);
  ok(eqDoc && eqDoc.data.off && eqDoc.data.off[0].d === pick.date && eqDoc.data.off[0].why === 'Vendor out of stock', 'saved on the item in the database');
  ok((await p.textContent('.sb-modal')).includes('Vendor out of stock'), 'date shows in the item\'s list with reason');
  if (process.env.SHOTS) { await p.evaluate(() => document.querySelector('.na-from').scrollIntoView({ block: 'center' })); await p.screenshot({ path: process.env.SHOTS + '/gear-off.png' }); }
  await p.keyboard.press('Escape'); await sleep(400);
  // the shoot using it is flagged, and the chip says why
  const flagged = await p.evaluate(id => { const card = document.getElementById('card-' + id); return card ? { na: card.innerHTML.includes('⛔ NA'), conflict: card.querySelectorAll('.is-conflict').length } : null; }, pick.ev);
  ok(flagged && flagged.na && flagged.conflict > 0, 'shoot card marks the item ⛔ NA and as a conflict');
  ok(/double-booked/.test(await p.textContent('#sb-summary') || await p.evaluate(() => document.body.innerText)), 'board summary counts it');
  // the other shoot that day: the item is greyed out in the gear picker with the reason
  const opened2 = await p.evaluate(id => { const card = document.getElementById('card-' + id); const btn = card && card.querySelector('[data-action="persongear"]'); if (!btn) return false; btn.click(); return true; }, pick.other);
  ok(opened2, 'opened the gear picker on the other shoot');
  await p.waitForSelector('.sb-modal');
  const row = await p.evaluate(name => { const r = [...document.querySelectorAll('.sb-modal label.sb-modal-row')].find(x => x.querySelector('.sb-modal-row-name').textContent.startsWith(name) && x.textContent.includes('Vendor out of stock')); return r ? { text: r.textContent.slice(0, 160), disabled: !!(r.querySelector('input[type=checkbox]') || {}).disabled } : null; }, pick.gname);
  ok(row && row.disabled, 'picker shows it greyed with the reason: ' + (row && row.text));
  await p.keyboard.press('Escape'); await sleep(300);
  // remove the date again
  await p.click('#sb-manage-gear'); await p.waitForSelector('.sb-modal');
  await p.evaluate(name => { const row = [...document.querySelectorAll('.sb-manage-row')].find(r => { const n = r.querySelector('.sb-manage-name'); return n && n.firstChild && n.firstChild.textContent.trim() === name; }); row.querySelector('.act-na').click(); }, pick.gname);
  await p.waitForSelector('[data-unoff]');
  // more days, to try "available again" on one day, on a range, and on all (18 Nov 2026, Ravi)
  const addD = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
  await p.fill('.na-from', addD(pick.date, 10)); await p.dispatchEvent('.na-from', 'change'); await p.fill('.na-to', addD(pick.date, 13)); await p.click('.na-add'); await sleep(800);
  ok(docs.get('gear/' + pick.gid).data.off.length === 5, 'marked 4 more days (5 in all)');
  if (process.env.SHOTS) { await p.evaluate(() => document.querySelector('.na-all').scrollIntoView({ block: 'center' })); await p.screenshot({ path: process.env.SHOTS + '/gear-back.png' }); }
  ok(/✓ available again/.test(await p.textContent('[data-unoff="' + pick.date + '"]')), 'each date has a clear "✓ available again" button');
  await p.click('[data-unoff="' + pick.date + '"]'); await sleep(800);
  ok(!docs.get('gear/' + pick.gid).data.off.some(x => x.d === pick.date) && /available again on/.test(await p.textContent('#sb-toast')), 'one day: available again on ' + pick.date);
  const after1 = await p.evaluate(id => { const card = document.getElementById('card-' + id); return card ? card.innerHTML.includes('⛔ NA') : null; }, pick.ev);
  ok(after1 === false, 'its shoot card is no longer marked ⛔ NA');
  await p.fill('.na-from', addD(pick.date, 11)); await p.dispatchEvent('.na-from', 'change'); await p.fill('.na-to', addD(pick.date, 12)); await p.click('.na-back'); await sleep(800);
  ok(docs.get('gear/' + pick.gid).data.off.map(x => x.d).join() === [addD(pick.date, 10), addD(pick.date, 13)].join(), 'a From–To range: those 2 days available again, the others stay');
  await p.click('.na-all'); await sleep(1200);
  ok(!docs.get('gear/' + pick.gid).data.off, '"Available again on all dates" clears the rest');
  await p.keyboard.press('Escape'); await sleep(300);
  const after = await p.evaluate(id => { const card = document.getElementById('card-' + id); return card ? card.innerHTML.includes('⛔ NA') : null; }, pick.ev);
  ok(after === false, 'card no longer marked');
  // an item with 3 units (Ravi, 18 Nov 2026: "Total 3 M4 bodies, I made one unavailable but it shows double booked to all others"): the form now marks 1 unit by default
  const q3 = await p.evaluate(() => { const A = window.__boardApi, st = A.state(), d0 = new Date(A.todayStr() + 'T12:00:00'); d0.setDate(d0.getDate() + 240); const day = d0.toISOString().slice(0, 10);
    const eq = { id: 'q3-test', name: 'Test M4', category: 'Body', qty: 3, order: 999 }; st.equipment.push(eq);
    const ps = st.shooters.filter(x => !x.left && !/team/i.test(x.role || '')), evs = [];
    for (let i = 0; i < 2; i++) { const e = A.cleanEvent({ name: 'Q3 shoot ' + i, date: day, slot: 'Evening', coverage: '1+0', location: 'Place ' + i }); e.assignments = [{ memberId: ps[i].id, gearIds: ['q3-test'] }]; st.events.push(e); evs.push(e.id); }
    A.save(); A.renderBoard(); return { day, evs, sid: ps[2].id }; });
  await p.click('#sb-manage-gear'); await p.waitForSelector('.sb-modal');
  await p.evaluate(() => { const row = [...document.querySelectorAll('.sb-manage-row')].find(r => { const n = r.querySelector('.sb-manage-name'); return n && n.firstChild && n.firstChild.textContent.trim() === 'Test M4'; }); row.querySelector('.act-na').click(); });
  await p.waitForSelector('.na-n');
  ok(await p.inputValue('.na-n') === '1', '3 units: "How many of the 3" starts at 1, not all 3');
  await p.fill('.na-from', q3.day); await p.dispatchEvent('.na-from', 'change'); await p.click('.na-add'); await sleep(800);
  ok(/Test M4 \(1 of 3\) marked not available/.test(await p.textContent('#sb-toast')) && /1 of 3/.test(await p.textContent('.sb-modal')), 'the toast and the date say "1 of 3"');
  const c3 = await p.evaluate(s => { const A = window.__boardApi, st = A.state(); const r = s.evs.map(id => A.hasConflict(st.events.find(e => e.id === id)));
    const e = A.cleanEvent({ name: 'Q3 shoot 2', date: s.day, slot: 'Evening', coverage: '1+0', location: 'Place 2' }); e.assignments = [{ memberId: s.sid, gearIds: ['q3-test'] }]; st.events.push(e);
    return { two: r, third: A.hasConflict(e) }; }, q3);
  ok(c3.two.every(x => !x), 'two shoots using 1 each that day are fine (2 of 3 still free)');
  ok(c3.third, 'a third one that day is double-booked (only 2 free)');
  await p.keyboard.press('Escape'); await sleep(300);
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close(); server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
