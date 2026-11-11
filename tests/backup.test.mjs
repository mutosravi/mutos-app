// Nightly backup: reads every table page by page, stores a Load-backup-compatible file, keeps 30 nights + monthly,
// and only the owner can list, download or start one.  Run: node tests/backup.test.mjs <backup.json> [out.json]
import fs from 'fs';
import { runBackup, makeBackup, STUDIO_TABLES } from '../worker/backup.js';
import vm from 'vm';
import { backupApi } from '../worker/index.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const src = JSON.parse(fs.readFileSync(process.argv[2]));
const docs = [];
const put = (c, list) => list.forEach(x => { const d = Object.assign({}, x); const id = d.id; delete d.id; docs.push({ collection: c, id, data: d }); });
put('events', src.events); put('shooters', src.shooters); put('gear', src.equipment); put('away', src.unavailability || []);
for (let i = 0; i < 1200; i++) docs.push({ collection: 'history', id: 'h' + i, data: { t: new Date(1.7e12 + i * 1e6).toISOString(), lines: ['x'] } }); // forces a second page
const members = [{ email: 'o@x.com', role: 'owner' }, { email: 'm@x.com', role: 'manager' }];
let pages = 0, broken = true;
// the studio's tables (12 Nov 2026): a few rows in some, one table missing (its SQL file not run yet)
const studioRows = { people: [{ id: 'p1', code: 'M001', name: 'Kuldeep' }], employees: [{ email: 'k@x.com', monthly_salary: 20000 }], att_punch: Array.from({ length: 1500 }, (_, i) => ({ id: i + 1, email: 'k@x.com', kind: 'in' })),
  drive_items: [{ id: 'd1', title: 'Sharma · Haldi', note: { nested: true } }], client_itinerary: [{ wedding_key: 'w:sharma', data: { vip: [{ name: 'Dadi', photo: 'data:image/jpeg;base64,AAAA' }] } }], booking_payments: [{ id: 'b1', amount: 100000 }] };
const fetchFn = async (url, opt = {}) => {
  const u = new URL(url);
  if (u.pathname === '/auth/v1/user') { const t = opt.headers.Authorization.split(' ')[1]; return t === 'bad' ? { ok: false } : { ok: true, json: async () => ({ email: t + '@x.com' }) }; }
  const table = u.pathname.split('/').pop(), off = Number(u.searchParams.get('offset') || 0), lim = Number(u.searchParams.get('limit') || 1e9);
  if (table === 'cards' && broken) return { ok: false, status: 404, text: async () => 'relation "cards" does not exist' };
  let rows = table === 'docs' ? docs : table === 'members' ? members.filter(m => !u.searchParams.get('email') || u.searchParams.get('email') === 'eq.' + m.email) : studioRows[table] || [];
  if (table === 'docs') pages++;
  return { ok: true, json: async () => rows.slice(off, off + lim) };
};
const store = new Map();
const KV = { async put(k, v, o) { store.set(k, { v, m: o && o.metadata }); }, async get(k) { return store.has(k) ? store.get(k).v : null; }, async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, metadata: store.get(name).m })), list_complete: true }; } };
const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'sb_secret_x', SUPABASE_PUBLISHABLE_KEY: 'pub', BACKUPS: KV };

const b = await makeBackup(env, fetchFn);
ok(pages >= 2, 'read the database in pages of 1000 (' + pages + ' pages)');
ok(b.events.length === src.events.length && b.shooters.length === src.shooters.length && b.equipment.length === src.equipment.length, 'every shoot, shooter and gear item included');
ok(b.events.every(e => e.id) && b.history.length === 500, 'ids kept; history trimmed to the latest 500');
ok(STUDIO_TABLES.every(([t]) => t === 'cards' ? !b.studio[t] : Array.isArray(b.studio[t])) && b.studio.att_punch.length === 1500 && b.studio.people[0].name === 'Kuldeep' && b.studio.booking_payments[0].amount === 100000,
  'every studio table is in the backup: people, attendance (all 1500 taps, read in pages), drives, clients, payments… (' + Object.keys(b.studio).length + ' tables)');
ok(/does not exist/.test(b.studio_errors.cards || ''), 'a table that cannot be read is named in the file, never silently empty');
ok(!('att_secret' in b.studio) && !('push_subs' in b.studio), 'the office code seed and phone sign-ups are left out');
// the same copy as an Excel file (the Backups window's Excel button)
{ const XLSX = vm.runInNewContext(fs.readFileSync(process.env.XLSX_JS || 'xlsx.full.min.js', 'utf8') + ';XLSX', { console }); const ctx = { window: {}, XLSX, console, setTimeout, clearTimeout, setInterval, document: { addEventListener() {} } };
  vm.runInNewContext(fs.readFileSync('public/crew-sync.js', 'utf8'), ctx);
  const wb = ctx.window.MUTOS_BACKUP_XLSX(JSON.parse(JSON.stringify(b))), buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' }), back = XLSX.read(buf, { type: 'buffer' });
  const tab = n => XLSX.utils.sheet_to_json(back.Sheets[n] || {});
  ok(back.SheetNames.includes('Shoots') && tab('Shoots').length === src.events.length && tab('att punch').length === 1500 && tab('people')[0].name === 'Kuldeep', 'Excel: one tab per part, every row (Shoots, people, att punch…) (' + back.SheetNames.length + ' tabs)');
  ok(/"nested":true/.test(tab('drive items')[0].note) && /NOT READ: cards/.test(JSON.stringify(tab('About'))), 'nested values kept as text; the About tab names any table that could not be read'); }
broken = false;
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(b));
// 35 nights pass
for (let i = 0; i < 35; i++) { const d = new Date(Date.UTC(2026, 10, 1 + i, 21, 30)); const orig = Date.now; Date.now = () => d.getTime(); await runBackup(env, 'nightly', fetchFn); Date.now = orig; }
const names = [...store.keys()];
const meta0 = store.get(names.find(n => n.startsWith('nightly/'))).m;
ok(meta0.tables === STUDIO_TABLES.length && meta0.rows > 1500 && meta0.errors === 0, 'each copy says how many studio records it holds (' + meta0.rows + ')');
ok(names.filter(n => n.startsWith('nightly/')).length === 30, 'keeps the last 30 nightly copies');
ok(names.includes('monthly/2026-12'), 'keeps the 1st of each month for good: ' + names.filter(n => n.startsWith('monthly/')).join(','));
ok(store.get(names.find(n => n.startsWith('nightly/'))).m.shoots === src.events.length, 'each copy is labelled with its shoot count');
// a big season: families' photos go in a second stored copy so one copy stays under Cloudflare's 25 MB
studioRows.client_itinerary = [{ wedding_key: 'w:big', data: { vip: [{ name: 'Dadi', photo: 'data:image/jpeg;base64,' + 'A'.repeat(21e6) }, { name: 'Nana' }] } }];
{ const orig = Date.now; Date.now = () => Date.UTC(2026, 11, 10, 21, 30); await runBackup(env, 'manual', fetchFn); Date.now = orig; }
const big = [...store.keys()].find(n => n.startsWith('manual/')), bigM = store.get(big).m, bigP = JSON.parse(store.get('photos/' + big).v);
ok(bigM.photos === 1 && store.get(big).v.length < 25e6 && /photos:w:big#0/.test(store.get(big).v) && bigP['w:big#0'].length > 21e6, 'over 20 MB: the photo moves to photos/' + big + ' and the main copy points to it');
// access
const call = (path, method, token) => backupApi(new Request('https://app.test' + path, { method: method || 'GET', headers: token ? { Authorization: 'Bearer ' + token } : {} }), env, fetchFn);
ok((await call('/api/backups', 'GET', 'm')).status === 403, 'a manager cannot open backups');
ok((await call('/api/backups', 'GET', 'bad')).status === 403 && (await call('/api/backups')).status === 403, 'signed-out or fake token refused');
const lr = await call('/api/backups', 'GET', 'o'); const list = (await lr.json()).backups;
ok(lr.status === 200 && list.length === 30 + names.filter(n => n.startsWith('monthly/')).length + 1, 'owner sees the list (30 nights, the monthly ones and 1 made by hand; photo copies are not listed separately) (' + list.length + ')');
const nr = await call('/api/backups/now', 'POST', 'o'); ok(nr.status === 200 && (await nr.json()).name.startsWith('manual/'), 'owner can back up now');
const fr = await call('/api/backups/file?name=' + encodeURIComponent(list[0].name), 'GET', 'o');
ok(fr.status === 200 && /attachment/.test(fr.headers.get('Content-Disposition')) && JSON.parse(await fr.text()).events.length === src.events.length, 'owner downloads a full file');
ok((await call('/api/backups/file?name=' + encodeURIComponent('../secret'), 'GET', 'o')).status === 400, 'only backup names can be downloaded');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
