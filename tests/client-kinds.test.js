// New client of any kind (17 Nov 2026, Ravi: "add not only wedding, instead a client with their functions like wedding, anniversary,
// birthday, event, others"). Run: node tests/client-kinds.test.js <backup.json>
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
  await new Promise(r => server.listen(8798, r));
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d)); await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8')); await ctx.addInitScript(() => { try { sessionStorage.setItem('mutos-stay-old', '1'); } catch (e) {} });
  const p = await ctx.newPage(), errs = []; p.on('pageerror', e => errs.push(String(e)));
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  await p.goto('http://localhost:8798/board.html#board'); await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });
  const day = n => p.evaluate(n => { const A = window.__boardApi, d = new Date(A.todayStr() + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }, n);
  ok(/New client/.test(await p.textContent('#sb-new-wedding')), 'the button says "＋ New client"');
  await p.click('#sb-new-wedding'); await p.waitForSelector('#nw-occ [data-occ]');
  ok((await p.$$eval('#nw-occ [data-occ]', l => l.map(x => x.dataset.occ).join(','))) === 'wedding,anniversary,birthday,event,other', 'kinds: wedding, anniversary, birthday, event, other');
  ok(/Mehndi/.test(await p.textContent('#nw-fns')), 'wedding starts with the wedding functions');
  await p.click('#nw-occ [data-occ="birthday"]');
  const fnNames = await p.$$eval('#nw-fns .sb-fn-row', l => l.map(r => r.dataset.fn).join('|'));
  ok(fnNames === 'Birthday party|Pre-birthday shoot|Puja / Havan', 'Birthday: the list becomes ' + fnNames);
  await p.fill('#nw-client', 'Aarav 1st'); await p.fill('#nw-cphone', '9876500123');
  const d1 = await day(150), d2 = await day(149);
  await p.fill('#nw-fns .sb-fn-row[data-fn="Birthday party"] .fn-date', d1); await p.dispatchEvent('#nw-fns .sb-fn-row[data-fn="Birthday party"] .fn-date', 'change');
  await p.fill('#nw-fns .sb-fn-row[data-fn="Pre-birthday shoot"] .fn-date', d2); await p.dispatchEvent('#nw-fns .sb-fn-row[data-fn="Pre-birthday shoot"] .fn-date', 'change');
  await p.click('#nw-save'); await sleep(500);
  const ev = await p.evaluate(() => window.__boardApi.state().events.filter(e => e.wedding === 'Aarav 1st').map(e => ({ id: e.id, name: e.name, occ: e.occasion, type: e.eventType, slot: e.slot })));
  ok(ev.length === 2 && ev.every(e => e.occ === 'birthday'), 'two shoots made, both kept as a birthday client');
  const party = ev.find(e => /party/.test(e.name)), pre = ev.find(e => /Pre/.test(e.name));
  ok(party.type === 'short' && pre.type === 'short' && party.slot === 'Evening' && pre.slot === 'Morning', 'short events for billing; the party in the evening, the pre-shoot in the morning');
  ok(/🎂 Aarav 1st birthday/.test(await p.textContent('#card-' + party.id)), 'the card says "🎂 Aarav 1st birthday"');
  // change the kind on one shoot: the whole client follows
  await p.click('#card-' + pre.id + ' [data-action="edit"]'); await p.waitForSelector('#ef-occ');
  await p.selectOption('#ef-occ', 'event'); await p.click('#ef-save'); await sleep(400);
  ok(await p.evaluate(() => window.__boardApi.state().events.filter(e => e.wedding === 'Aarav 1st').every(e => e.occasion === 'event')), 'Edit shoot → Kind of client = Event: every shoot of that client changes');
  await p.click('#card-' + pre.id + ' [data-action="edit"]'); await p.waitForSelector('#ef-occ');
  await p.selectOption('#ef-occ', 'wedding'); await p.click('#ef-save'); await sleep(400);
  ok(await p.evaluate(() => window.__boardApi.state().events.filter(e => e.wedding === 'Aarav 1st').every(e => !('occasion' in e))), 'back to Wedding: the field goes (wedding is the default, old shoots unchanged)');
  await p.click('#card-' + pre.id + ' [data-action="edit"]'); await p.waitForSelector('#ef-occ'); await p.selectOption('#ef-occ', 'birthday'); await p.click('#ef-save'); await sleep(400);
  // the Clients window and what the family's page gets
  await p.evaluate(() => window.MUTOS_CLIENTS.open()); await p.waitForSelector('.sb-modal .cl-occ');
  ok(/🎂 Birthday/.test(await p.textContent('.sb-modal')), 'Clients window: the client shows "🎂 Birthday"');
  const feed = await p.evaluate(() => { const w = window.MUTOS_CLIENTS._weddings().find(x => x.title === 'Aarav 1st'); return w && w.occasion; });
  ok(feed === 'birthday', 'the client is grouped with its kind (sent to the family\'s page with each function)');
  const crew = await p.evaluate(id => { const A = window.__boardApi, e = A.state().events.find(x => x.id === id); return e.occasion; }, party.id);
  ok(crew === 'birthday', 'kept on the shoot for the crew pages');
  if (process.env.SHOTS) await p.screenshot({ path: process.env.SHOTS + '/client-kinds.png' });
  ok(errs.length === 0, 'no page errors ' + errs.slice(0, 2).join(' | '));
  await b.close(); server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
