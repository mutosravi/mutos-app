// 23 Nov 2026 (Ravi): switch a shooter with his gear, time and place in bold on board cards, join shoots into one client,
// and every window a full page on a phone. Run: node tests/switch-join.test.js <backup.json>
const path = require('path'), fs = require('fs'), http = require('http'); const { chromium } = require('playwright');
process.chdir(path.resolve(__dirname, '..'));
const ROOT = path.resolve('public'), OWNER = 'o@x.com', docs = new Map(), sleep = ms => new Promise(r => setTimeout(r, ms));
const bk = JSON.parse(fs.readFileSync(process.argv[2]));
[['events', bk.events], ['shooters', bk.shooters], ['gear', bk.equipment], ['assistants', bk.assistants || []], ['away', bk.unavailability || []], ['seasons', bk.seasons || []]].forEach(([c, l]) => l.forEach(e => docs.set(c + '/' + e.id, { collection: c, id: e.id, data: e })));
const members = new Map([[OWNER, { email: OWNER, role: 'owner' }]]);
function handle(d) { if (d.op === 'session') return { id: 'u1', email: OWNER, user_metadata: {} }; const t = d.table === 'docs' ? docs : d.table === 'members' ? members : new Map();
  const match = r => d.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v : true);
  if (d.op === 'select') { let rows = [...t.values()].filter(match); if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1); return { data: d.single ? rows[0] || null : rows, error: null }; }
  if (d.op === 'upsert') { d.rows.forEach(r => { if (d.table === 'docs') t.set(r.collection + '/' + r.id, r); }); return { data: null, error: null }; }
  if (d.op === 'delete' && d.table === 'docs') { [...t.values()].filter(match).forEach(r => t.delete(r.collection + '/' + r.id)); return { data: null, error: null }; }
  return { data: null, error: null }; }
const server = http.createServer((q, s) => { const p = q.url.split('?')[0], f = path.join(ROOT, p); if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); s.end(fs.readFileSync(f)); });
(async () => {
  await new Promise(r => server.listen(8797, r));
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d)); await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8')); await ctx.addInitScript(() => { try { sessionStorage.setItem('mutos-stay-old', '1'); localStorage.removeItem('sb-switch-gear'); } catch (e) {} });
  const p = await ctx.newPage(), errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('dialog', d => d.accept());
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  await p.goto('http://localhost:8797/board.html#board'); await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });
  const set = await p.evaluate(() => {
    const A = window.__boardApi, st = A.state(), d0 = new Date(A.todayStr() + 'T12:00:00'); d0.setDate(d0.getDate() + 250); const day = d0.toISOString().slice(0, 10);
    const free = st.shooters.filter(x => !x.left && !/team/i.test(x.name) && !st.events.some(e => e.date === day && e.assignments.some(a => a.memberId === x.id))).slice(0, 2);
    const g = st.equipment.filter(x => !x.left).slice(0, 2);
    const mk = (name, slot, who, gid, extra) => { const E = A.cleanEvent(Object.assign({ name, date: day, slot, coverage: '1+0', location: 'Lucknow' }, extra || {})); E.assignments = [{ memberId: who.id, gearIds: [gid] }]; st.events.push(E); return E.id; };
    const ids = [mk('SJ Haldi', 'Morning', free[0], g[0].id, { callTime: '07:30', location: 'Clarks Awadh', mapLink: 'https://maps.app.goo.gl/x' }), mk('SJ Mehendi', 'Evening', free[1], g[1].id)];
    // two shoots of the same family without a client name, plus one under a name
    const nn = (name, extra) => { const E = A.cleanEvent(Object.assign({ name, date: day, slot: 'Evening', coverage: '1+0', location: 'Lucknow', contactPhone: '9000000001' }, extra || {})); st.events.push(E); return E.id; };
    const loose = [nn('Loose Ring'), nn('Loose Party', { contactPhone: '' })];
    A.save(); A.renderBoard(); return { day, ids, loose, a: free[0].id, b: free[1].id, g0: g[0].id, g1: g[1].id, gn: [g[0].name, g[1].name] };
  });
  const evOf = id => p.evaluate(i => JSON.parse(JSON.stringify(window.__boardApi.state().events.find(e => e.id === i))), id);
  await p.evaluate(d => window.__boardApi.goToDate(d), set.day); await p.waitForSelector('#card-' + set.ids[0]);
  // time and place stand out
  const ww = await p.$eval('#card-' + set.ids[0] + ' .sb-card-ww', x => ({ t: x.querySelector('.sb-ww-time').textContent, l: x.querySelector('.sb-ww-loc').textContent, map: !!x.querySelector('.sb-ww-map'), bg: window.getComputedStyle(x.querySelector('.sb-ww-time')).backgroundColor, w: window.getComputedStyle(x.querySelector('.sb-ww-loc')).fontWeight }));
  ok(/Report 7:30\s*am/i.test(ww.t) && /Clarks Awadh/.test(ww.l) && ww.map && ww.bg !== 'rgba(0, 0, 0, 0)' && +ww.w >= 700, 'board card: "⏰ Report 7:30 am" on a dark pill, "📍 Clarks Awadh" bold, Map ↗ (' + ww.t + ' · ' + ww.l + ')');
  ok(/not set/.test(await p.textContent('#card-' + set.ids[1] + ' .sb-ww-time.tbc')), 'no report time: a dashed "Report time not set" warning');
  // switch with the gear staying with the slot (as before)
  const sw = async () => { await p.click('#card-' + set.ids[0] + ' [data-action="switchshooter"][data-member="' + set.a + '"]'); await p.waitForSelector('#sw-gear'); };
  await sw();
  ok(await p.getAttribute('#sw-gear [data-g="slot"]', 'class') === 'on' && /gear stays with each slot/.test(await p.textContent('#sw-list')), 'Switch window: "Gear: stays with the slot | goes with the person", slot picked first');
  await p.click('#sw-gear [data-g="person"]'); await p.waitForSelector('#sw-gear [data-g="person"].on');
  ok(/gear goes with each person/.test(await p.textContent('#sw-list')) && (await p.textContent('#sw-list')).includes(set.gn[0] + ' ⇄ ' + set.gn[1]), 'with the person: the swap row shows the two kits trading places (' + set.gn[0] + ' ⇄ ' + set.gn[1] + ')');
  await p.click('#sw-list .sb-switch-row[data-s="0"]'); await sleep(300);
  let e0 = await evOf(set.ids[0]), e1 = await evOf(set.ids[1]);
  ok(e0.assignments[0].memberId === set.b && e0.assignments[0].gearIds.join() === set.g1 && e1.assignments[0].memberId === set.a && e1.assignments[0].gearIds.join() === set.g0, 'swap with gear: each person takes his own gear to the other shoot');
  ok(await p.evaluate(() => localStorage.getItem('sb-switch-gear')) === 'person', 'the choice is remembered on this device');
  await p.click('#card-' + set.ids[0] + ' [data-action="switchshooter"][data-member="' + set.b + '"]'); await p.waitForSelector('#sw-gear [data-g="person"].on');
  await p.click('#sw-gear [data-g="slot"]'); await p.waitForSelector('#sw-gear [data-g="slot"].on');
  await p.click('#sw-list .sb-switch-row[data-s="0"]'); await sleep(300);
  e0 = await evOf(set.ids[0]); e1 = await evOf(set.ids[1]);
  ok(e0.assignments[0].memberId === set.a && e0.assignments[0].gearIds.join() === set.g1 && e1.assignments[0].memberId === set.b && e1.assignments[0].gearIds.join() === set.g0, 'swap with gear staying: people swap, each slot keeps its gear');
  // join shoots into one client
  await p.evaluate(() => window.MUTOS_CLIENTS.open()); await p.waitForSelector('#cl-joinsel'); await p.click('#cl-joinsel'); await p.waitForSelector('#jn-list');
  const rows = await p.$$eval('#jn-list .jn-pick', xs => xs.map(x => x.value));
  ok(set.loose.every(id => rows.includes(id)) && await p.evaluate(r => r.every(id => !window.__boardApi.state().events.find(e => e.id === id).wedding), rows), 'Join window lists the shoots with no client name (' + rows.length + ')');
  for (const id of set.loose) await p.check('#jn-list .jn-pick[value="' + id + '"]');
  await p.fill('#jn-name', 'Verma wedding');
  ok((await p.textContent('#jn-n')) === '2', 'two ticked');
  await p.click('#jn-go'); await p.waitForSelector('#cl-joinsel'); await sleep(200);
  const ws = await p.evaluate(ids => ids.map(i => window.__boardApi.state().events.find(e => e.id === i).wedding), set.loose);
  ok(ws.every(w => w === 'Verma wedding') && /Verma wedding/.test(await p.textContent('#cl-list')), 'Join: both shoots are now the client "Verma wedding" and it shows in Clients');
  await p.evaluate(() => window.__boardApi.closeModal());
  // phone: a window is a page with Back
  await p.setViewportSize({ width: 390, height: 844 }); await sleep(200);
  await p.click('#card-' + set.ids[0] + ' [data-action="switchshooter"][data-member="' + set.a + '"]'); await p.waitForSelector('#sb-active-modal .mutos-pageback'); await sleep(400);
  const box = await p.$eval('#sb-active-modal .sb-modal', m => { const r = m.getBoundingClientRect(); return { l: r.left, w: r.width, b: r.bottom }; });
  ok(box.l === 0 && box.w === 390 && box.b >= 840 && /Switch/.test(await p.textContent('#sb-active-modal .mutos-pagetitle')), 'phone: the Switch window fills the screen with "‹ Back  Switch …" on top');
  if (process.env.SHOTS) await p.screenshot({ path: path.join(process.env.SHOTS, 'phone-page.png') });
  await p.click('#sb-active-modal .mutos-pageback'); await p.waitForSelector('#sb-active-modal', { state: 'detached' });
  ok(true, 'Back closes it');
  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close(); server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
