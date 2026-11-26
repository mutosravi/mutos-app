// A far shoot's travel day (before / after) shows a travelling card on that day (26 Nov 2026, Ravi).
// Run: node tests/travel-card.test.js <backup.json>
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
  await new Promise(r => server.listen(8803, r));
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d)); await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8')); await ctx.addInitScript(() => { try { sessionStorage.setItem('mutos-stay-old', '1'); } catch (e) {} });
  const p = await ctx.newPage(), errs = []; p.on('pageerror', e => errs.push(String(e)));
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  await p.goto('http://localhost:8803/board.html#board'); await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });
  // a far shoot in Goa with a travel day before and after; nothing booked the day before, a Lucknow shoot the day after
  const set = await p.evaluate(() => {
    const A = window.__boardApi, st = A.state(), d0 = new Date(A.todayStr() + 'T12:00:00'); d0.setDate(d0.getDate() + 230);
    const day = n => { const x = new Date(d0); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
    const x = st.shooters.find(s => !s.left && !/team/i.test(s.role || '')), gear = st.equipment.find(e => !/kit/i.test(e.category || ''));
    const G = A.cleanEvent({ name: 'Goa Wedding', wedding: 'Goa Wedding', date: day(0), slot: 'Evening', coverage: '1+0', location: 'Goa', outstation: true, farBefore: true, farAfter: true });
    G.assignments = [{ memberId: x.id, gearIds: [gear.id] }];
    const N = A.cleanEvent({ name: 'Lucknow Ring', date: day(1), slot: 'Evening', coverage: '1+0', location: 'Lucknow', outstation: false });
    st.events.push(G, N); A.save(); A.renderBoard();
    return { x: x.name, gear: gear.name, G: G.id, N: N.id, before: day(-1), after: day(1), day2: day(2) };
  });
  const card = sel => p.$(sel);
  const before = '#sec-' + set.before + ' .sb-travel-card[data-ev="' + set.G + '"][data-side="before"]';
  ok(!!(await card(before)), 'the day before (nothing booked) gets its own date with a travelling card');
  const bt = await p.textContent(before);
  ok(/Travelling · day before/.test(bt) && /Going to Goa/.test(bt) && bt.includes(set.x) && bt.includes(set.gear), 'it says "Going to Goa", who is away (' + set.x + ') and the gear (' + set.gear + ')');
  ok(/1 travelling/.test(await p.textContent('#sec-' + set.before + ' .sb-date-count')), 'the date head counts "🛫 1 travelling"');
  const after = '#sec-' + set.after + ' .sb-travel-card[data-ev="' + set.G + '"][data-side="after"]';
  ok(!!(await card(after)) && !!(await card('#sec-' + set.after + ' #card-' + set.N)) && /Coming back from Goa/.test(await p.textContent(after)), 'the day after: the Lucknow shoot and the "Coming back from Goa" card side by side');
  if (process.env.SHOTS) await (await p.$('#sec-' + set.after)).screenshot({ path: process.env.SHOTS + '/travel-card-day.png' });
  await p.click(after + ' .sb-travel-go'); await sleep(400);
  ok(await p.evaluate(id => document.getElementById('card-' + id).classList.contains('sb-flash'), set.G), '"Open Goa Wedding" goes to the shoot and lights it up');
  // travel day off → card gone
  await p.evaluate(s => { const A = window.__boardApi, G = A.state().events.find(e => e.id === s.G); G.farBefore = false; A.save(); A.renderBoard(); }, set);
  ok(!(await card(before)) && !(await card('#sec-' + set.before)), 'travel day before switched off: that card (and the empty date) are gone');
  // another function of the same wedding at the same place the next day: they are shooting there, not travelling
  await p.evaluate(s => { const A = window.__boardApi, st = A.state(); const R = A.cleanEvent({ name: 'Goa Reception', wedding: 'Goa Wedding', date: s.after, slot: 'Evening', coverage: '1+0', location: 'Goa', outstation: true });
    st.events.push(R); A.save(); A.renderBoard(); }, set);
  ok(!(await card(after)), 'a shoot at the same place on that day: no "travelling" card for it');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/travel-card.png', fullPage: false });
  ok(errs.length === 0, 'no page errors ' + errs.slice(0, 2).join(' | '));
  await b.close(); server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
