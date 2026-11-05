// Nightly backup: reads every table page by page, stores a Load-backup-compatible file, keeps 30 nights + monthly,
// and only the owner can list, download or start one.  Run: node tests/backup.test.mjs <backup.json> [out.json]
import fs from 'fs';
import { runBackup, makeBackup } from '../worker/backup.js';
import { backupApi } from '../worker/index.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const src = JSON.parse(fs.readFileSync(process.argv[2]));
const docs = [];
const put = (c, list) => list.forEach(x => { const d = Object.assign({}, x); const id = d.id; delete d.id; docs.push({ collection: c, id, data: d }); });
put('events', src.events); put('shooters', src.shooters); put('gear', src.equipment); put('away', src.unavailability || []);
for (let i = 0; i < 1200; i++) docs.push({ collection: 'history', id: 'h' + i, data: { t: new Date(1.7e12 + i * 1e6).toISOString(), lines: ['x'] } }); // forces a second page
const members = [{ email: 'o@x.com', role: 'owner' }, { email: 'm@x.com', role: 'manager' }];
let pages = 0;
const fetchFn = async (url, opt = {}) => {
  const u = new URL(url);
  if (u.pathname === '/auth/v1/user') { const t = opt.headers.Authorization.split(' ')[1]; return t === 'bad' ? { ok: false } : { ok: true, json: async () => ({ email: t + '@x.com' }) }; }
  const table = u.pathname.split('/').pop(), off = Number(u.searchParams.get('offset') || 0), lim = Number(u.searchParams.get('limit') || 1e9);
  let rows = table === 'docs' ? docs : table === 'members' ? members.filter(m => !u.searchParams.get('email') || u.searchParams.get('email') === 'eq.' + m.email) : [];
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
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify(b));
// 35 nights pass
for (let i = 0; i < 35; i++) { const d = new Date(Date.UTC(2026, 10, 1 + i, 21, 30)); const orig = Date.now; Date.now = () => d.getTime(); await runBackup(env, 'nightly', fetchFn); Date.now = orig; }
const names = [...store.keys()];
ok(names.filter(n => n.startsWith('nightly/')).length === 30, 'keeps the last 30 nightly copies');
ok(names.includes('monthly/2026-12'), 'keeps the 1st of each month for good: ' + names.filter(n => n.startsWith('monthly/')).join(','));
ok(store.get(names.find(n => n.startsWith('nightly/'))).m.shoots === src.events.length, 'each copy is labelled with its shoot count');
// access
const call = (path, method, token) => backupApi(new Request('https://app.test' + path, { method: method || 'GET', headers: token ? { Authorization: 'Bearer ' + token } : {} }), env, fetchFn);
ok((await call('/api/backups', 'GET', 'm')).status === 403, 'a manager cannot open backups');
ok((await call('/api/backups', 'GET', 'bad')).status === 403 && (await call('/api/backups')).status === 403, 'signed-out or fake token refused');
const lr = await call('/api/backups', 'GET', 'o'); const list = (await lr.json()).backups;
ok(lr.status === 200 && list.length === 30 + names.filter(n => n.startsWith('monthly/')).length, 'owner sees the list (' + list.length + ')');
const nr = await call('/api/backups/now', 'POST', 'o'); ok(nr.status === 200 && (await nr.json()).name.startsWith('manual/'), 'owner can back up now');
const fr = await call('/api/backups/file?name=' + encodeURIComponent(list[0].name), 'GET', 'o');
ok(fr.status === 200 && /attachment/.test(fr.headers.get('Content-Disposition')) && JSON.parse(await fr.text()).events.length === src.events.length, 'owner downloads a full file');
ok((await call('/api/backups/file?name=' + encodeURIComponent('../secret'), 'GET', 'o')).status === 400, 'only backup names can be downloaded');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
