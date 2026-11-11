// Changes made on another device while this one was in the background (no live message arrives: a phone cuts the
// connection) show as soon as the board comes back to the front, without losing an unsaved change made here.
// Run: node tests/resume.test.js <backup.json>
const path = require('path'), fs = require('fs'), http = require('http'); const { chromium } = require('playwright');
process.chdir(path.resolve(__dirname, '..'));
const ROOT = path.resolve('public'), OWNER = 'o@x.com'; const sleep = ms => new Promise(r => setTimeout(r, ms));
const docs = new Map(); const bk = JSON.parse(fs.readFileSync(process.argv[2]));
bk.events.forEach(e => docs.set('events/' + e.id, { collection: 'events', id: e.id, data: e }));
bk.shooters.forEach(e => docs.set('shooters/' + e.id, { collection: 'shooters', id: e.id, data: e }));
bk.equipment.forEach(e => docs.set('gear/' + e.id, { collection: 'gear', id: e.id, data: e }));
const members = new Map([[OWNER, { email: OWNER, role: 'owner' }]]);
let slow = 60;
async function handle(d) {
  if (d.op === 'session') return { id: 'u1', email: OWNER, user_metadata: {} };
  await sleep(slow);
  const t = d.table === 'docs' ? docs : d.table === 'members' ? members : new Map();
  const match = r => d.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v : op === 'gte' ? String(r[c]) >= v : v.includes(r[c]));
  if (d.op === 'select') { let rows = [...t.values()].filter(match); if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1); return { data: d.single ? rows[0] || null : JSON.parse(JSON.stringify(rows)), error: null }; }
  if (d.op === 'upsert') { d.rows.forEach(r => { t.set(d.table === 'docs' ? r.collection + '/' + r.id : (r.email || r.person_key || r.id), r); }); return { data: null, error: null }; } // no live message on purpose
  if (d.op === 'delete') { [...t.entries()].forEach(([k, r]) => { if (match(r)) t.delete(k); }); return { data: null, error: null }; }
  return { data: null, error: null };
}
const server = http.createServer((q, s) => { let p = q.url.split('?')[0]; if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(s); });
(async () => {
  await new Promise(r => server.listen(8841, r));
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d));
  await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8'));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  await p.goto('http://localhost:8841/board.html#board');
  await p.waitForFunction(() => window.__boardApi && window.__boardApi.state().events.length, null, { timeout: 20000 });
  await sleep(3200); // past the "just loaded" guard
  const [a, c2, mine] = bk.events.slice(0, 3).map(e => e.id);
  const locOf = id => p.evaluate(i => (window.__boardApi.state().events.find(e => e.id === i) || {}).location, id);
  const wake = () => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  // the laptop changes one shoot, deletes another and adds a new one; this phone hears nothing
  docs.get('events/' + a).data = Object.assign({}, docs.get('events/' + a).data, { location: 'Changed on the laptop' });
  docs.delete('events/' + c2);
  docs.set('events/lap-new', { collection: 'events', id: 'lap-new', data: Object.assign({}, bk.events[0], { id: 'lap-new', name: 'Added on the laptop', assignments: [], equipmentIds: [] }) });
  await sleep(600);
  ok(await locOf(a) !== 'Changed on the laptop', 'while in the background the phone still shows the old venue (the bug Ravi saw)');
  // an unsaved change made on the phone at the same moment must survive the refresh
  slow = 1500;
  await p.evaluate(id => { const ev = window.__boardApi.state().events.find(e => e.id === id); ev.notes = 'typed on the phone'; window.__boardApi.save(); }, mine);
  await wake(); slow = 60; await sleep(5000);
  ok(await locOf(a) === 'Changed on the laptop', 'coming back to the app shows the laptop\'s change');
  ok(await p.evaluate(id => !window.__boardApi.state().events.find(e => e.id === id), c2), '… the shoot deleted on the laptop is gone');
  ok(await p.evaluate(() => !!window.__boardApi.state().events.find(e => e.id === 'lap-new')), '… the shoot added on the laptop is there');
  ok(await p.evaluate(id => window.__boardApi.state().events.find(e => e.id === id).notes, mine) === 'typed on the phone' && docs.get('events/' + mine).data.notes === 'typed on the phone', 'the phone\'s own change made at that moment is kept and saved');
  ok(docs.get('events/' + a).data.location === 'Changed on the laptop' && !docs.has('events/' + c2), 'the refresh did not write the old copy back over the laptop\'s changes');
  // back online after losing the connection
  docs.get('events/' + a).data = Object.assign({}, docs.get('events/' + a).data, { location: 'Changed again' });
  await p.evaluate(() => window.dispatchEvent(new Event('online'))); await sleep(2500);
  ok(await locOf(a) === 'Changed again', 'coming back online also catches up');
  ok(errs.length === 0, 'no page errors ' + errs.slice(0, 2).join(' | '));
  await b.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
