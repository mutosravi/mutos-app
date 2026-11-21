// One shoot of a day at a time: a drop-down on every date (21 Nov 2026, Ravi). Run: node tests/day-pick.test.js <backup.json>
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
  await new Promise(r => server.listen(8796, r));
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d)); await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8')); await ctx.addInitScript(() => { try { sessionStorage.setItem('mutos-stay-old', '1'); } catch (e) {} });
  const p = await ctx.newPage(), errs = []; p.on('pageerror', e => errs.push(String(e)));
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  await p.goto('http://localhost:8796/board.html#board'); await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });
  const set = await p.evaluate(() => {
    const A = window.__boardApi, st = A.state(), d0 = new Date(A.todayStr() + 'T12:00:00'); d0.setDate(d0.getDate() + 240); const day = d0.toISOString().slice(0, 10);
    const mk = (name, slot) => { const E = A.cleanEvent({ name, date: day, slot, coverage: '1+0', location: 'Lucknow' }); st.events.push(E); return E.id; };
    const ids = [mk('Pick Test Haldi', 'Morning'), mk('Pick Test Sangeet', 'Evening'), mk('Pick Test Party', 'Evening')];
    A.save(); A.renderBoard(); return { day, ids };
  });
  const sec = '#sec-' + set.day, cards = () => p.$$eval(sec + ' .sb-card', cs => cs.map(c => c.id.replace('card-', '')));
  await p.evaluate(d => window.__boardApi.goToDate(d), set.day); await p.waitForSelector(sec + ' .sb-day-pick');
  const opts = await p.$$eval(sec + ' .sb-day-pick option', os => os.map(o => o.textContent));
  ok(opts[0] === 'All shoots (3)' && opts.length === 4 && opts.some(o => /^Pick Test Sangeet · Evening/.test(o)), 'every date has a drop-down: "All shoots (3)" and each shoot (' + opts.slice(1).join(' | ') + ')');
  ok((await cards()).length === 3, 'All shoots: the three cards');
  await p.selectOption(sec + ' .sb-day-pick', set.ids[1]); await sleep(300);
  ok(JSON.stringify(await cards()) === JSON.stringify([set.ids[1]]) && await p.isVisible(sec + ' .sb-day-all') && (await p.textContent(sec + ' .sb-day-all')) === 'Show all 3 shoots of this day', 'pick Sangeet: only its card, with "Show all 3 shoots of this day"');
  if (process.env.SHOTS) { await p.evaluate(s => document.querySelector(s).scrollIntoView(), sec); await p.screenshot({ path: path.join(process.env.SHOTS, 'day-pick.png') }); }
  ok((await p.$$eval('#sec-' + set.day + ' .sb-available', x => x.length)) === 1, 'the day\'s free crew and gear stay shown');
  await p.evaluate(() => window.__boardApi.renderBoard()); await sleep(200);
  ok(JSON.stringify(await cards()) === JSON.stringify([set.ids[1]]) && await p.inputValue(sec + ' .sb-day-pick') === set.ids[1], 'the choice stays when the board redraws');
  await p.click(sec + ' .sb-day-all'); await sleep(300);
  ok((await cards()).length === 3 && await p.inputValue(sec + ' .sb-day-pick') === '', '"Show all" brings back every shoot of the day');
  await p.selectOption(sec + ' .sb-day-pick', set.ids[2]); await sleep(200); await p.selectOption(sec + ' .sb-day-pick', ''); await sleep(200);
  ok((await cards()).length === 3, 'picking "All shoots" in the drop-down does the same');
  await p.selectOption(sec + ' .sb-day-pick', set.ids[0]); await sleep(200); await p.evaluate(d => window.__boardApi.goToDate(d), set.day); await sleep(300);
  ok((await cards()).length === 3, 'going to the date from elsewhere (Team updates, calendar) shows all its shoots again');
  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close(); server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
