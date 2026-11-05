// Team Alignment sync inside the app board: the board's Drive call goes to /api/team-sheet.
// Run: node tests/team-sync.test.js <backup.json> <team-alignment.xlsx as base64 text>
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
const SHEET_B64 = fs.readFileSync(process.argv[3], 'utf8').trim(); let sheetCalls = 0;
const server = http.createServer((q, s) => {
  if (q.url === '/api/team-sheet' && q.method === 'POST') { sheetCalls++; s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ content: SHEET_B64 })); return; } let p = q.url.split('?')[0]; if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(s); });
(async () => {
  await new Promise(r => server.listen(8792, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d));
  await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8'));
  // the board loads its spreadsheet reader from cdnjs; serve a local copy if the test machine is offline (XLSX_JS=path)
  if (process.env.XLSX_JS) await ctx.route('**/xlsx.full.min.js', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(process.env.XLSX_JS, 'utf8') }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://localhost:8792/board.html#board');
  await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });
  await p.waitForSelector('#sb-team-now', { timeout: 20000 }); // the button only appears when the board can sync (owner + reader loaded)
  await p.waitForTimeout(3500); // the automatic sync after loading
  if (!sheetCalls) await p.click('#sb-team-now');
  await p.waitForFunction(() => /Synced|Could not read|to confirm/i.test(document.getElementById('sb-team-status').textContent + (document.getElementById('sb-inbox-pill') || {}).textContent), null, { timeout: 60000 });
  const st = await p.textContent('#sb-team-status');
  const pill = await p.$('#sb-inbox-pill'); const pillTxt = pill ? await pill.textContent() : '';
  console.log('status:', st.replace(/\s+/g, ' ').slice(0, 200)); console.log('pill:', pillTxt, 'sheet calls:', sheetCalls);
  const crewPanel = await p.isHidden('#sb-crew-status');
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  ok(sheetCalls >= 1, 'board asked the app server for the sheet');
  ok(!/Could not read|not connected|not available/i.test(st), 'no sync error');
  ok(/from Team Alignment to confirm/.test(pillTxt), 'new bookings from the sheet are waiting to confirm');
  ok(crewPanel, 'old Drive crew-sheet panel hidden in the app');
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await b.close(); server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
