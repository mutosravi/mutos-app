// A shooter on an outstation shoot stays in the pickers, marked outstation, and can be picked for a nearby shoot the same day
// (or on a far shoot's travel day): he stays on the outstation shoot and the two are linked as "team travels" (17 Nov 2026, Ravi).
// Run: node tests/outstation-pick.test.js <backup.json>
const path = require('path'), fs = require('fs'), http = require('http'); const { chromium } = require('playwright');
process.chdir(path.resolve(__dirname, '..'));
const ROOT = path.resolve('public'), OWNER = 'o@x.com', docs = new Map(), sleep = ms => new Promise(r => setTimeout(r, ms));
const bk = JSON.parse(fs.readFileSync(process.argv[2]));
bk.events.forEach(e => docs.set('events/' + e.id, { collection: 'events', id: e.id, data: e })); bk.shooters.forEach(e => docs.set('shooters/' + e.id, { collection: 'shooters', id: e.id, data: e })); bk.equipment.forEach(e => docs.set('gear/' + e.id, { collection: 'gear', id: e.id, data: e }));
const members = new Map([[OWNER, { email: OWNER, role: 'owner' }]]);
function handle(d) { if (d.op === 'session') return { id: 'u1', email: OWNER, user_metadata: {} }; const t = d.table === 'docs' ? docs : d.table === 'members' ? members : new Map();
  const match = r => d.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v : true);
  if (d.op === 'select') { let rows = [...t.values()].filter(match); if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1); return { data: d.single ? rows[0] || null : rows, error: null }; }
  if (d.op === 'upsert') { d.rows.forEach(r => { if (d.table === 'docs') t.set(r.collection + '/' + r.id, r); }); return { data: null, error: null }; }
  return { data: null, error: null }; }
const server = http.createServer((q, s) => { const p = q.url.split('?')[0], f = path.join(ROOT, p); if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); s.end(fs.readFileSync(f)); });
(async () => {
  await new Promise(r => server.listen(8797, r));
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d)); await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8')); await ctx.addInitScript(() => { try { sessionStorage.setItem('mutos-stay-old', '1'); } catch (e) {} });
  const p = await ctx.newPage(), errs = []; p.on('pageerror', e => errs.push(String(e)));
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  await p.goto('http://localhost:8797/board.html#board'); await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });
  // a free day far ahead: an outstation morning shoot with X, and a Lucknow evening shoot the same day
  const set = await p.evaluate(() => {
    const A = window.__boardApi, st = A.state(), d0 = new Date(A.todayStr() + 'T12:00:00'); d0.setDate(d0.getDate() + 200);
    const day = n => { const x = new Date(d0); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    const x = st.shooters.find(s => !s.left && !/team/i.test(s.role || '')), y = st.shooters.find(s => !s.left && s.id !== x.id && !/team/i.test(s.role || ''));
    const O = A.cleanEvent({ name: 'Agra Haldi', date: day(0), slot: 'Morning', coverage: '1+0', location: 'Agra', outstation: true });
    O.assignments = [{ memberId: x.id, gearIds: [] }];
    const L = A.cleanEvent({ name: 'Lucknow Sangeet', date: day(0), slot: 'Evening', coverage: '1+0', location: 'Taj Hotel Lucknow', outstation: false });
    const M = A.cleanEvent({ name: 'Kanpur Mehndi', date: day(0), slot: 'Morning', coverage: '1+0', location: 'Kanpur', outstation: true });
    const F = A.cleanEvent({ name: 'Goa Wedding', date: day(10), slot: 'Evening', coverage: '1+0', location: 'Goa', outstation: true, farAfter: true });
    F.assignments = [{ memberId: y.id, gearIds: [] }];
    const N = A.cleanEvent({ name: 'Lucknow Ring', date: day(11), slot: 'Evening', coverage: '1+0', location: 'Lucknow', outstation: false });
    st.events.push(O, L, M, F, N); A.save(); A.renderBoard();
    return { x: x.id, xn: x.name, y: y.id, yn: y.name, O: O.id, L: L.id, M: M.id, F: F.id, N: N.id };
  });
  const rowOf = async (name) => p.evaluate(n => { const r = [...document.querySelectorAll('.sb-modal-row')].find(x => x.querySelector('.sb-modal-row-name').textContent.startsWith(n)); return r ? { sub: r.querySelector('.sb-modal-row-sub').textContent, dis: r.querySelector('input').disabled } : null; }, name);
  await p.click('#card-' + set.L + ' [data-action="crew"]'); await p.waitForSelector('.sb-modal-row');
  const r1 = await rowOf(set.xn);
  ok(r1 && !r1.dis && /Outstation · Agra \(Agra Haldi, Morning\)/.test(r1.sub), 'Lucknow Sangeet (evening): ' + set.xn + ' is listed and pickable, marked "' + (r1 && r1.sub) + '"');
  await p.evaluate(n => [...document.querySelectorAll('.sb-modal-row')].find(x => x.querySelector('.sb-modal-row-name').textContent.startsWith(n)).querySelector('input').click(), set.xn); await sleep(300);
  const tmsg = await p.evaluate(() => (document.getElementById('sb-toast') || {}).textContent || '');
  await p.keyboard.press('Escape'); await sleep(400);
  const a1 = await p.evaluate(s => { const A = window.__boardApi, st = A.state(), O = st.events.find(e => e.id === s.O), L = st.events.find(e => e.id === s.L);
    return { onO: O.assignments.some(a => a.memberId === s.x), onL: L.assignments.some(a => a.memberId === s.x), link: (L.travelFrom || []).includes(s.O), cO: A.hasConflict(O), cL: A.hasConflict(L) }; }, set);
  ok(a1.onO && a1.onL, 'picked: he is on both (not moved off the outstation shoot)');
  ok(a1.link && !a1.cO && !a1.cL, 'the two shoots are linked as "team travels" and neither is double-booked');
  ok(/Undo/.test(tmsg), 'the usual "added … Undo" note');
  const card = await p.textContent('#card-' + set.L);
  ok(/Agra/.test(card) && /travel/i.test(card), 'the Lucknow card shows the travel link from Agra Haldi');
  // same time, another place: still a real clash (not offered as "outstation")
  await p.click('#card-' + set.M + ' [data-action="crew"]'); await p.waitForSelector('.sb-modal-row');
  const r2 = await rowOf(set.xn);
  ok(r2 && !/Outstation/.test(r2.sub) && /move here|Busy/.test(r2.sub), 'Kanpur Mehndi at the same time (morning): he shows as busy / move here, as before (' + (r2 && r2.sub) + ')');
  await p.keyboard.press('Escape'); await sleep(300);
  // the travel day after a far shoot
  await p.click('#card-' + set.N + ' [data-action="crew"]'); await p.waitForSelector('.sb-modal-row');
  const r3 = await rowOf(set.yn);
  ok(r3 && !r3.dis && /Goa .*travel day/.test(r3.sub), 'day after the Goa shoot: ' + set.yn + ' listed as "' + (r3 && r3.sub) + '"');
  await p.keyboard.press('Escape');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/outstation-pick.png' });
  ok(errs.length === 0, 'no page errors ' + errs.slice(0, 2).join(' | '));
  await b.close(); server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
