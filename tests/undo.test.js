// Undo / redo in the app board, with live echoes from the database. Run: node tests/undo.test.js <backup.json>
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
  await new Promise(r => server.listen(8791, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d));
  await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8'));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errs.push(m.text()); }); // 404: no sheet server in this test
  await p.goto('http://localhost:8791/board.html#board');
  await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });
  await p.evaluate(() => { window.__rtHook = true; });
  rt = x => p.evaluate(y => window.__rtFire(y), x).catch(() => {});
  // UI change: remove first person from first shoot card via its × button
  const ev0 = await p.evaluate(() => { const e = window.__boardApi.state().events.find(e => e.assignments.some(a => a.memberId)); return { id: e.id, n: e.assignments.filter(a => a.memberId).length, name: e.name }; });
  console.log('shoot', ev0);
  await p.evaluate(id => { const e = window.__boardApi.state().events.find(x => x.id === id); e.assignments.find(a => a.memberId).memberId = ''; window.__boardApi.save(); }, ev0.id);
  await sleep(1500);
  const after = await p.evaluate(id => window.__boardApi.state().events.find(x => x.id === id).assignments.filter(a => a.memberId).length, ev0.id);
  console.log('after change', after, 'undo pill', !!(await p.$('#sb-undo')));
  await p.click('#sb-undo'); await sleep(2500);
  const undone = await p.evaluate(id => window.__boardApi.state().events.find(x => x.id === id).assignments.filter(a => a.memberId).length, ev0.id);
  const dbN = docs.get('events/' + ev0.id).data.assignments.filter(a => a.memberId).length;
  console.log('after undo: board', undone, 'db', dbN, 'pill', !!(await p.$('#sb-undo')));
  // keyboard
  await p.evaluate(id => { const e = window.__boardApi.state().events.find(x => x.id === id); e.name = e.name + ' X'; window.__boardApi.save(); }, ev0.id); await sleep(1200);
  await p.mouse.click(5, 5); await p.keyboard.press('Control+z'); await sleep(2000);
  console.log('ctrl+z name back:', await p.evaluate(id => window.__boardApi.state().events.find(x => x.id === id).name, ev0.id) === ev0.name, 'db', docs.get('events/' + ev0.id).data.name);
  // redo after undo, by button and keyboard
  await p.click('#sb-redo'); await sleep(2000);
  console.log('redo button -> name has X:', (await p.evaluate(id => window.__boardApi.state().events.find(x => x.id === id).name, ev0.id)).endsWith(' X'), 'db', docs.get('events/' + ev0.id).data.name);
  await p.mouse.click(5, 5); await p.keyboard.press('Control+z'); await sleep(1500);
  await p.mouse.click(5, 5); await p.keyboard.press('Control+y'); await sleep(1500);
  console.log('ctrl+z then ctrl+y -> X:', docs.get('events/' + ev0.id).data.name.endsWith(' X'));
  await p.keyboard.press('Control+z'); await sleep(800); await p.keyboard.press('Control+Shift+z'); await sleep(1500);
  console.log('ctrl+shift+z redo:', docs.get('events/' + ev0.id).data.name.endsWith(' X'));
  // new change clears redo
  await p.keyboard.press('Control+z'); await sleep(800);
  console.log('redo pill visible:', !!(await p.$('#sb-redo')));
  await p.evaluate(id => { const e = window.__boardApi.state().events.find(x => x.id === id); e.notes = 'n'; window.__boardApi.save(); }, ev0.id); await sleep(800);
  console.log('after a new change, redo pill gone:', !(await p.$('#sb-redo')));
  // system saves are not undo steps
  const before = await p.evaluate(() => document.querySelectorAll('#sb-undo').length);
  await p.evaluate(() => { window.__boardApi.state().unavailability.push({ id: 'sys-x', personType: 'shooter', personId: window.__boardApi.state().shooters[0].id, date: '2026-12-01', slot: 'Full day', reason: 'x' }); window.__boardApi.saveSystem(); }); await sleep(800);
  console.log('right after system save:', await p.evaluate(() => window.__boardApi.state().unavailability.map(u => u.id)), [...docs.keys()].filter(k => k.startsWith('away')));
  await p.click('#sb-undo'); await sleep(1500);
  console.log('undo after system save undid the note, not the away date:', docs.get('events/' + ev0.id).data.notes !== 'n', docs.has('away/sys-x'), await p.evaluate(() => window.__boardApi.state().unavailability.map(u => u.id)), [...docs.keys()].filter(k => k.startsWith('away')));
  console.log('errors', errs);
  await b.close(); server.close();
})();
