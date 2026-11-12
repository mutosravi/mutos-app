// Quick visits (a vendor's decor shoot) never double-book people; default kit in the gear picker keeps its count and its place in the list.
// Run: node tests/quick-visit.test.js <backup.json>   (12 Nov 2026, Ravi)
const path = require('path'), fs = require('fs');
process.chdir(path.resolve(__dirname, '..'));
const http = require('http'); const { chromium } = require('playwright');
const ROOT = path.resolve('public'); const OWNER = 'o@x.com';
const docs = new Map(); const sleep = ms => new Promise(r => setTimeout(r, ms));
const bk = JSON.parse(fs.readFileSync(process.argv[2]));
bk.events.forEach(e => docs.set('events/' + e.id, { collection: 'events', id: e.id, data: e }));
bk.shooters.forEach(e => docs.set('shooters/' + e.id, { collection: 'shooters', id: e.id, data: e }));
bk.equipment.forEach(e => docs.set('gear/' + e.id, { collection: 'gear', id: e.id, data: e }));
const members = new Map([[OWNER, { email: OWNER, role: 'owner' }]]);
async function handle(d) {
  if (d.op === 'session') return { id: 'u1', email: OWNER, user_metadata: {} };
  await sleep(30);
  const t = d.table === 'docs' ? docs : d.table === 'members' ? members : new Map();
  const match = r => d.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v : op === 'gte' ? String(r[c]) >= v : v.includes(r[c]));
  if (d.op === 'select') { let rows = [...t.values()].filter(match); if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1); return { data: d.single ? rows[0] || null : rows, error: null }; }
  if (d.op === 'upsert') { d.rows.forEach(r => { const k = d.table === 'docs' ? r.collection + '/' + r.id : (r.email || r.person_key); t.set(k, r); }); return { data: null, error: null }; }
  if (d.op === 'delete') { [...t.entries()].forEach(([k, r]) => { if (match(r)) t.delete(k); }); return { data: null, error: null }; }
  return { data: null, error: null };
}
const server = http.createServer((q, s) => { let p = q.url.split('?')[0]; if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; }
  s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); s.end(fs.readFileSync(f)); });
(async () => {
  await new Promise(r => server.listen(8795, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d));
  await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8'));
  await ctx.addInitScript(() => { try { sessionStorage.setItem('mutos-stay-old', '1'); } catch (e) {} });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  await p.goto('http://localhost:8795/board.html#board');
  await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });

  // a future shoot with a shooter who has no clash; add a vendor's decor shoot at the same time
  const pick = await p.evaluate(() => {
    const A = window.__boardApi, st = A.state(), today = A.todayStr();
    for (const ev of st.events) {
      if (ev.date < today || !A.isActive(ev) || A.hasConflict(ev)) continue;
      const a = ev.assignments.find(x => x.memberId && st.shooters.some(s => s.id === x.memberId && !s.left));
      if (!a) continue;
      const nv = A.cleanEvent({ name: 'Scarlet Decor', date: ev.date, slot: ev.slot, coverage: '1+0', location: 'Scarlet showroom' });
      st.events.push(nv); A.save(); A.renderBoard();
      return { main: ev.id, mainName: ev.name, quick: nv.id, member: a.memberId, name: st.shooters.find(s => s.id === a.memberId).name };
    }
    return null; });
  ok(!!pick, 'a shoot with a shooter, and a new "Scarlet Decor" shoot at the same time: ' + (pick && pick.name + ' on ' + pick.mainName));

  // without the switch: he is busy there (ticking would move him off his shoot)
  await p.click('#card-' + pick.quick + ' [data-action="crew"]'); await p.waitForSelector('.sb-modal-row');
  const before = await p.evaluate(n => { const r = [...document.querySelectorAll('.sb-modal-row')].find(x => x.querySelector('.sb-modal-row-name').textContent.startsWith(n)); return r ? r.querySelector('.sb-modal-row-sub').textContent : null; }, pick.name);
  ok(/move here|Busy/.test(before || ''), 'before: in the crew list he shows as "' + before + '"');
  await p.keyboard.press('Escape'); await sleep(300);

  // tick "Quick visit" on the shoot
  await p.click('#card-' + pick.quick + ' [data-action="edit"]'); await p.waitForSelector('#ef-quick');
  ok((await p.textContent('.sb-modal')).includes('Quick visit'), 'the shoot form has the "Quick visit" switch');
  await p.check('#ef-quick'); await p.click('#ef-save');
  for (let i = 0; i < 40 && !(docs.get('events/' + pick.quick) || { data: {} }).data.quick; i++) await sleep(150);
  ok(docs.get('events/' + pick.quick).data.quick === true, 'saved on the shoot');
  ok((await p.textContent('#card-' + pick.quick)).includes('Quick visit'), 'the card shows ⚡ Quick visit');

  // now he can be added there as well, and stays on his own shoot
  await p.click('#card-' + pick.quick + ' [data-action="crew"]'); await p.waitForSelector('.sb-modal-row');
  const row = await p.evaluateHandle(n => [...document.querySelectorAll('.sb-modal-row')].find(x => x.querySelector('.sb-modal-row-name').textContent.startsWith(n)), pick.name);
  ok(!(await row.evaluate(r => r.querySelector('input').disabled)) && !/move here|Busy/.test(await row.evaluate(r => r.querySelector('.sb-modal-row-sub').textContent)), 'he is free to add (not busy, not moved)');
  await row.evaluate(r => r.querySelector('input').click()); await sleep(300);
  await p.keyboard.press('Escape'); await sleep(500);
  const after = await p.evaluate(x => { const A = window.__boardApi, st = A.state(), m = st.events.find(e => e.id === x.main), q = st.events.find(e => e.id === x.quick);
    return { onMain: m.assignments.some(a => a.memberId === x.member), onQuick: q.assignments.some(a => a.memberId === x.member), cm: A.hasConflict(m), cq: A.hasConflict(q) }; }, pick);
  ok(after.onMain && after.onQuick, 'he is on both: his own shoot and the quick visit');
  ok(!after.cm && !after.cq, 'neither shoot is marked double-booked');
  ok(!(await p.textContent('#card-' + pick.main)).includes('Double-booked') && !(await p.textContent('#card-' + pick.quick)).includes('Double-booked'), 'no "Double-booked" banner on either card');
  const feed = await p.evaluate(x => window.__boardApi.crewFeedFor ? JSON.stringify(window.__boardApi.crewFeedFor(window.__boardApi.normalizeName(x.name))) : '', pick);
  ok(/Scarlet Decor/.test(feed), 'his crew page lists the quick visit too');
  // switch off again: now it is a double booking
  const cOff = await p.evaluate(x => { const A = window.__boardApi, q = A.state().events.find(e => e.id === x.quick); delete q.quick; const c = A.hasConflict(q); q.quick = true; return c; }, pick);
  ok(cOff, 'without the switch the same thing would be a double booking');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/quick-visit.png' });

  // ── default kit in the gear picker: count shown, and still in the main list ──
  const kit = await p.evaluate(x => {
    const A = window.__boardApi, st = A.state(), m = st.events.find(e => e.id === x.main);
    const busy = new Set(st.events.filter(o => o.date === m.date && A.isActive(o)).flatMap(o => o.assignments.flatMap(a => a.gearIds).concat(o.equipmentIds || [])));
    const multi = st.equipment.find(e => (e.category || '').toLowerCase() !== 'kit' && !e.vendor && !busy.has(e.id) && !(e.off || []).length);
    if (!multi) return null;
    multi.qty = 3;   // three bodies of this one
    const sh = st.shooters.find(s => s.id === x.member); sh.defaultGear = [multi.id]; A.save(); A.renderBoard();
    return { gid: multi.id, name: multi.name, group: multi.category || 'Other', qty: multi.qty };
  }, pick);
  ok(!!kit, 'a gear item with several units as his default kit: ' + (kit && kit.name + ' ×' + kit.qty));
  await p.click('#card-' + pick.main + ' [data-action="persongear"][data-member="' + pick.member + '"]'); await p.waitForSelector('.sb-modal-row');
  const rows = await p.evaluate(nm => { let g = ''; const out = []; document.querySelectorAll('#sb-modal-list > *').forEach(el => { if (el.classList.contains('sb-modal-group')) g = el.textContent; else if (el.classList.contains('sb-modal-row') && el.querySelector('.sb-modal-row-name').textContent.startsWith(nm)) out.push({ g, sub: el.querySelector('.sb-modal-row-sub').textContent }); }); return out; }, kit.name);
  ok(rows.length === 2 && rows[0].g === 'Default kit' && rows[1].g === kit.group, 'it shows on top under Default kit AND in its own group "' + kit.group + '" (' + rows.map(r => r.g).join(' / ') + ')');
  ok(rows.every(r => /\d+ of \d+ free/.test(r.sub)), 'both rows say how many are left: ' + rows.map(r => r.sub).join(' | '));
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/default-kit.png' });
  ok(errs.length === 0, 'no page errors ' + errs.slice(0, 2).join(' | '));
  await b.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
