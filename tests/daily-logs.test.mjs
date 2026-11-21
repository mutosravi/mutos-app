// Daily Excel of cards and drives (21 Nov 2026, Ravi: "turn on daily excel sheet backup of data (cards and drives) with logs and
// original location of data"): worker/logs.js + worker/xlsx.js. Run: XLSX_JS=xlsx.full.min.js node tests/daily-logs.test.mjs
import fs from 'fs';
import vm from 'vm';
import { makeLogs, runDailyLogs } from '../worker/logs.js';
import { backupApi } from '../worker/index.js';
import { _resetTokenCache } from '../worker/photos.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const XLSX = vm.runInNewContext(fs.readFileSync(process.env.XLSX_JS || 'xlsx.full.min.js', 'utf8') + ';XLSX', { console });

const at = (d, h = 10) => new Date(Date.UTC(2026, 10, d, h)).toISOString();
const rows = {
  people: [{ id: 'p1', code: 'M001', name: 'Shrey' }, { id: 'p2', code: 'M002', name: 'Kuldeep' }],
  cards: [{ id: 'k1', code: 'C01', kind: 'CFexpress B', data: 'copied', cycle: 1, condition: 'ok', errors: 0, holder: null }, { id: 'k2', code: 'C02', kind: 'SD', data: 'hold', cycle: 1, condition: 'ok', holder: 'p1' }],
  card_moves: [{ id: 'm1', card: 'k2', from_person: null, to_person: 'p1', given_by: 'o@x.com', status: 'accepted', given_at: at(18) }],
  card_uses: [{ id: 'u1', card: 'k1', cycle: 1, used: true, shoot: 'Sharma Haldi', wedding: 'Sharma', media: 'photo', style: 'candid', at: at(18), by_email: 'shrey@x.com' }],
  card_copies: [{ id: 'cc1', card: 'k1', cycle: 1, backup: false, drive: 'dr1', drive_name: 'M 5', folder: 'Sharma/Haldi', files: 812, items: ['i1'], at: at(19), by_email: 'o@x.com' }],
  card_log: [{ id: 'l1', card: 'k1', what: 'Copied to M 5', at: at(19), by_email: 'o@x.com' }],
  drives: [{ id: 'dr1', name: 'M 5', kind: 'SSD', status: 'in_use', holder: null }, { id: 'dr2', name: 'Dibba 2', kind: 'HDD', status: 'in_use', holder: 'p2' }],
  drive_items: [
    { id: 'i1', drive: 'dr1', title: 'Sharma · Haldi', what: 'raw', path: 'Sharma/Haldi', files: 812, size_label: '100 GB', wedding_key: 'w:sharma', added_at: at(19), added_by: 'o@x.com' },
    { id: 'i2', drive: 'dr2', title: 'Sharma · Haldi', what: 'backup', path: '2026/Sharma/Haldi', files: 812, from_item: 'i1', wedding_key: 'w:sharma', added_at: at(20), added_by: 'o@x.com' },
    { id: 'i3', drive: 'dr1', title: 'Gupta · Mehndi', what: 'raw', path: 'Gupta', added_at: at(17), added_by: 'm@x.com' },
    { id: 'i4', drive: 'dr1', title: 'Old job', what: 'final', path: 'Old', added_at: at(1), removed_at: at(15), removed_why: 'Client delivered' }],
  drive_moves: [], drive_log: [{ id: 'g1', drive: 'dr1', what: 'Deleted from the drive (Client delivered): Old', at: at(15), by_email: 'o@x.com' }],
  gear_log: [{ id: 'gl1', gear_name: 'M4', action: 'out', qty: 1, person_name: 'Shrey', condition: 'good', at: at(18), by_email: 'g@x.com' }],
  client_log: [{ id: 'h1', wedding: 'Sharma', shoot: 'Sharma Haldi', card: 'k1', what: 'Copied', at: at(19), by_email: 'o@x.com' }]
};
const drive = { files: new Map(), folders: [] };
let driveOn = false, ownerTok = 'o';
const fetchFn = async (url, opt = {}) => {
  const u = new URL(url);
  if (u.hostname === 'oauth2.googleapis.com') return { ok: true, json: async () => ({ access_token: 'gtok', expires_in: 3600 }) };
  if (u.hostname === 'www.googleapis.com' && u.pathname === '/drive/v3/files' && (opt.method || 'GET') === 'GET') return { ok: true, json: async () => ({ files: [] }) };
  if (u.hostname === 'www.googleapis.com' && u.pathname === '/drive/v3/files') { const b = JSON.parse(opt.body); drive.folders.push(b.name); return { ok: true, json: async () => ({ id: 'fold-' + drive.folders.length }) }; }
  if (u.hostname === 'www.googleapis.com' && u.pathname === '/upload/drive/v3/files') { const meta = JSON.parse(opt.body); return { ok: true, status: 200, headers: { get: k => k === 'Location' ? 'https://upload.test/s?n=' + encodeURIComponent(meta.name) + '&p=' + meta.parents[0] : null } }; }
  if (u.hostname === 'upload.test') { const id = 'f' + (drive.files.size + 1); drive.files.set(id, { name: u.searchParams.get('n'), parent: u.searchParams.get('p'), bytes: opt.body }); return { ok: true, json: async () => ({ id }) }; }
  if (u.pathname === '/auth/v1/user') { const t = opt.headers.Authorization.split(' ')[1]; return { ok: true, json: async () => ({ email: t + '@x.com' }) }; }
  const table = u.pathname.split('/').pop(), off = Number(u.searchParams.get('offset') || 0), lim = Number(u.searchParams.get('limit') || 1e9);
  if (table === 'members') return { ok: true, json: async () => [{ email: 'o@x.com', role: 'owner' }, { email: 'm@x.com', role: 'manager' }].filter(m => !u.searchParams.get('email') || u.searchParams.get('email') === 'eq.' + m.email) };
  if (!(table in rows)) return { ok: false, status: 404, text: async () => 'relation does not exist' };
  return { ok: true, json: async () => rows[table].slice(off, off + lim) };
};
const store = new Map();
const KV = { async put(k, v, o) { store.set(k, { v, m: o && o.metadata }); }, async get(k, type) { if (!store.has(k)) return null; const v = store.get(k).v; return type === 'arrayBuffer' && v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v; }, async delete(k) { store.delete(k); },
  async list({ prefix }) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).sort().map(name => ({ name, metadata: store.get(name).m })), list_complete: true }; } };
const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'sb_secret_x', SUPABASE_PUBLISHABLE_KEY: 'pub', BACKUPS: KV, GDRIVE_CLIENT_ID: 'cid', GDRIVE_CLIENT_SECRET: 'sec' };

// the file opens in Excel (read back with SheetJS) and says where every folder came from
const { bytes, meta } = await makeLogs(env, fetchFn);
const wb = XLSX.read(bytes, { type: 'array' }), sheet = n => XLSX.utils.sheet_to_json(wb.Sheets[n], { defval: '' });
ok(wb.SheetNames.join('|') === 'About|Where the data is|Cards now|Card handovers|Card notes (shoots)|Card copies|Card history|Drives now|Drive contents (all)|Drive handovers|Drive history|Gear log|Client history', 'a real .xlsx with the tabs: ' + wb.SheetNames.join(', '));
const where = sheet('Where the data is'), haldi = where.find(r => r.Drive === 'M 5' && r.Data === 'Sharma · Haldi'), bk = where.find(r => r.Drive === 'Dibba 2'), gupta = where.find(r => r.Data === 'Gupta · Mehndi');
ok(where.length === 3 && !where.some(r => r.Data === 'Old job'), '"Where the data is": every folder now on a drive (3), not the deleted one');
ok(haldi['Full location'] === 'M 5 › Sharma › Haldi' && haldi['Drive is now'] === 'In the office' && haldi.Files === 812 && /^Card C01 \(Sharma Haldi, photo, candid\), first copy/.test(haldi['Came from (original location)']) && haldi['Other copies'] === 'Dibba 2 › 2026 › Sharma › Haldi' && /^Yes/.test(haldi.Backup),
  'Haldi raw: full location M 5 › Sharma › Haldi, in the office, came from card C01 (Sharma Haldi, photo, candid), other copy on Dibba 2');
ok(bk['Came from (original location)'] === 'Copied from M 5 › Sharma › Haldi' && bk['Drive is now'] === 'With Kuldeep', 'the backup on Dibba 2: copied from M 5 › Sharma › Haldi; Dibba 2 is with Kuldeep');
ok(gupta.Backup === 'NO BACKUP' && /^Typed in by m@x.com/.test(gupta['Came from (original location)']), 'a raw folder with no other copy says NO BACKUP; one typed in by hand says who typed it');
const cardsNow = sheet('Cards now');
ok(cardsNow.find(r => r.Card === 'C01')['Footage is on'] === 'M 5 › Sharma › Haldi' && /HOLD/.test(cardsNow.find(r => r.Card === 'C02').Footage) && cardsNow.find(r => r.Card === 'C02').With === 'Shrey', 'Cards now: where each card\'s footage is (C01 → M 5 › Sharma › Haldi), C02 on hold with Shrey');
ok(sheet('Drive contents (all)').some(r => r.Data === 'Old job' && r['Why removed'] === 'Client delivered') && sheet('Gear log').length === 1 && sheet('Card history').length === 1, 'removed lines with their reason, and every log tab');
ok(meta.noBackup === 1 && meta.onHold === 1 && meta.folders === 3, 'About: 1 raw folder without backup, 1 card on hold');

// nightly: kept in KV; Google Drive not connected yet → only KV
let r = await runDailyLogs(env, fetchFn);
ok(/^logs\/\d{4}-\d\d-\d\d$/.test(r.name) && store.get(r.name).v instanceof Uint8Array && !r.drive && drive.files.size === 0, 'kept in the backups store (' + r.name + '); not on Google Drive while it is not connected');
// Google Drive connected (Photos on Google Drive) → also saved there, in Daily logs (Excel) / <month>
await KV.put('gdrive:auth', JSON.stringify({ refresh: 'rt', root: 'root1', email: 'mutos.media@gmail.com' })); _resetTokenCache();
r = await runDailyLogs(env, fetchFn);
const f = [...drive.files.values()][0];
ok(r.drive && f && /^Muto's cards and drives \d{4}-\d\d-\d\d\.xlsx$/.test(f.name) && drive.folders.join('/') === 'Daily logs (Excel)/' + r.name.slice(5, 12), 'Drive connected: saved as "' + (f && f.name) + '" in Daily logs (Excel) / ' + r.name.slice(5, 12));
// old ones are pruned after 60 days
for (let i = 0; i < 65; i++) await KV.put('logs/2025-0' + (1 + (i % 9)) + '-' + String(10 + i).padStart(2, '0'), new Uint8Array([1]), { metadata: {} });
await runDailyLogs(env, fetchFn);
ok([...store.keys()].filter(k => k.startsWith('logs/')).length === 60, 'only the last 60 days are kept');

// the Backups window: list, make now, download (owner only)
const req = (path, method = 'GET', tok = ownerTok) => new Request('https://app.test' + path, { method, headers: { Authorization: 'Bearer ' + tok } });
let res = await backupApi(req('/api/backups/logs'), env, fetchFn); const list = (await res.json()).logs;
ok(res.ok && list.length >= 60 && list[0].name.startsWith('logs/2026') && list[0].folders === 3, 'the owner sees the list, newest first, with folders and cards');
res = await backupApi(req('/api/backups/logs/file?name=' + encodeURIComponent(list[0].name)), env, fetchFn);
ok(res.ok && /spreadsheetml/.test(res.headers.get('Content-Type')) && XLSX.read(new Uint8Array(await res.arrayBuffer()), { type: 'array' }).SheetNames[1] === 'Where the data is', 'Download gives the .xlsx');
res = await backupApi(req('/api/backups/logs/file?name=' + encodeURIComponent('../secret')), env, fetchFn);
ok(res.status === 400, 'only daily Excel files can be downloaded this way');
res = await backupApi(req('/api/backups/logs', 'GET', 'm'), env, fetchFn);
ok(res.status === 403, 'a manager cannot open the backups (owner only, as before)');
res = await backupApi(req('/api/backups/logs/now', 'POST'), env, fetchFn);
ok(res.ok && (await res.json()).folders === 3, '"Excel now" makes today\'s file at once');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
