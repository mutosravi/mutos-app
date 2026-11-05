// Loading a backup into an empty app board must write every record, show progress, and warn before leaving mid-save.
// Run: node tests/load-backup.test.js <backup.json>
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', 'public');
const BACKUP = process.argv[2];
const OWNER = 'owner.test@gmail.com';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const docs = new Map(), members = new Map([[OWNER, { email: OWNER, role: 'owner' }]]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function handle(d) {
  if (d.op === 'session') return { id: 'u1', email: OWNER, user_metadata: { full_name: 'Owner' } };
  if (d.op === 'signout' || d.op === 'signin') return null;
  await sleep(40 + Math.random() * 60); // network delay India → Mumbai and back
  const t = d.table === 'docs' ? docs : d.table === 'members' ? members : new Map();
  const match = r => d.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v : v.includes(r[c]));
  if (d.op === 'select') { let rows = [...t.values()].filter(match); if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1); if (d.limit) rows = rows.slice(0, d.limit); return { data: d.single ? rows[0] || null : rows, error: null }; }
  if (d.op === 'upsert') { d.rows.forEach(r => t.set(d.table === 'docs' ? r.collection + '/' + r.id : (r.email || r.person_key), Object.assign({ updated_at: new Date().toISOString() }, r))); return { data: null, error: null }; }
  if (d.op === 'delete') { [...t.entries()].forEach(([k, r]) => { if (match(r)) t.delete(k); }); return { data: null, error: null }; }
}
const server = http.createServer((q, s) => { let p = q.url.split('?')[0]; if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(s); });
(async () => {
  const want = JSON.parse(fs.readFileSync(BACKUP));
  await new Promise(r => server.listen(8788, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d));
  await ctx.addInitScript(fs.readFileSync(path.join(__dirname, 'mock-supabase.js'), 'utf8'));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.goto('http://localhost:8788/board.html#board');
  await p.waitForSelector('#mutos-bar');
  await p.waitForFunction(() => /Saved to cloud · 0 shoots/.test(document.body.innerText), null, { timeout: 15000 });
  await p.setInputFiles('#sb-restore-input', BACKUP);
  await p.waitForSelector('#mutos-saving:not([hidden])', { timeout: 5000 }).then(() => ok(true, 'progress badge shows while saving')).catch(() => ok(false, 'progress badge shows while saving'));
  const t0 = Date.now();
  // leaving mid-save must ask first
  let asked = false; p.once('dialog', async dlg => { asked = dlg.type() === 'beforeunload'; await dlg.dismiss(); });
  await p.close({ runBeforeUnload: true }); await sleep(500);
  ok(asked && !p.isClosed(), 'closing the page mid-save asks to stay');
  await p.waitForFunction(() => window.__mutosInflight() === 0 && /Saved to cloud/.test(document.body.innerText), null, { timeout: 120000 });
  const n = c => [...docs.values()].filter(r => r.collection === c).length;
  console.log('saved in', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  ok(n('events') === want.events.length, 'all shoots written: ' + n('events') + '/' + want.events.length);
  ok(n('shooters') === want.shooters.length, 'all shooters written: ' + n('shooters'));
  ok(n('gear') === want.equipment.length, 'all gear written: ' + n('gear'));
  ok(n('away') === want.unavailability.length, 'away dates written: ' + n('away'));
  ok(await p.isHidden('#mutos-saving'), 'badge gone when finished');
  // a reload shows everything
  await p.reload(); await p.waitForFunction(() => /Saved to cloud · \d+ shoots/.test(document.body.innerText), null, { timeout: 20000 });
  const line = await p.evaluate(() => document.body.innerText.match(/Saved to cloud · \d+ shoots/)[0]);
  ok(line === 'Saved to cloud · ' + want.events.length + ' shoots', 'after reload: ' + line);
  ok(!errs.length, 'no page errors ' + errs.join(' | '));
  await browser.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
