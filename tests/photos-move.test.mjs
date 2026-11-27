// Switching the studio Gmail keeps the earlier Drive, and "Move photos" copies the app's photos into the new one (worker/photos.js).
// Run: node tests/photos-move.test.mjs
import { photosApi, _resetTokenCache } from '../worker/photos.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const SB = 'https://sb.test', kv = new Map();
const env = { SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: 'pub', SUPABASE_SECRET_KEY: 'sb_secret_x', GDRIVE_CLIENT_ID: 'cid', GDRIVE_CLIENT_SECRET: 'csecret',
  BACKUPS: { get: async k => kv.has(k) ? kv.get(k) : null, put: async (k, v) => { kv.set(k, v); }, delete: async k => { kv.delete(k); } } };
const users = { 'tok-owner': ['o@x.com', 'owner'], 'tok-man': ['m@x.com', 'manager'] };
// two Google accounts: old (refresh rt-old, token at-old) and new (rt-new / at-new)
const drives = { old: new Map(), new: new Map() }; let n = 1, nextLogin = 'old';
const acctOf = t => t === 'Bearer at-old' ? 'old' : t === 'Bearer at-new' ? 'new' : null;
const rows = [], links = [{ wedding_key: 'w:sharma', title: 'Sharma' }];
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: Object.assign({ 'Content-Type': 'application/json' }, h) });
async function fakeFetch(u, init = {}) {
  u = String(u); const h = new Headers(init.headers || {}), m = init.method || 'GET', who = acctOf(h.get('Authorization'));
  if (u === SB + '/auth/v1/user') { const t = (h.get('Authorization') || '').slice(7); return users[t] ? J({ email: users[t][0] }) : J({}, 401); }
  if (u.startsWith(SB + '/rest/v1/members')) { const e = decodeURIComponent(u.split('email=eq.')[1]); const r = Object.values(users).find(x => x[0] === e); return J(r ? [{ role: r[1] }] : []); }
  if (u.startsWith(SB + '/rest/v1/client_links')) return J(links.filter(l => u.includes(encodeURIComponent(l.wedding_key))));
  if (u.startsWith(SB + '/rest/v1/uploads?select=*&status=eq.ok')) { const q = new URL(u), off = +q.searchParams.get('offset'), lim = +q.searchParams.get('limit');
    return J(rows.slice(off, off + lim), 200, { 'Content-Range': off + '-' + (off + lim - 1) + '/' + rows.length }); }
  if (u.startsWith(SB + '/rest/v1/uploads?id=eq.') && m === 'PATCH') { Object.assign(rows.find(r => r.id === u.split('id=eq.')[1]), JSON.parse(init.body)); return new Response(null, { status: 204 }); }
  if (u === 'https://oauth2.googleapis.com/token') { const p = new URLSearchParams(init.body);
    if (p.get('grant_type') === 'authorization_code') return nextLogin === 'old' ? J({ access_token: 'at-old', refresh_token: 'rt-old', expires_in: 3600 }) : J({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 3600 });
    return J({ access_token: p.get('refresh_token') === 'rt-old' ? 'at-old' : 'at-new', expires_in: 3600 }); }
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) return J({});
  if (u === 'https://www.googleapis.com/oauth2/v2/userinfo') return J({ email: who === 'old' ? 'old.studio@gmail.com' : 'new.studio@gmail.com' });
  const D = drives[who];
  if (u.startsWith('https://www.googleapis.com/drive/v3/files?') && m === 'GET') { const q = decodeURIComponent(u);
    const name = (q.match(/name = '((?:[^'\\]|\\.)*)'/) || [])[1]; const par = (q.match(/'([^']+)' in parents/) || [])[1];
    return J({ files: [...D.entries()].filter(([, f]) => f.folder && f.name === String(name).replace(/\\'/g, "'") && (par === 'root' ? !f.parent : f.parent === par)).map(([id]) => ({ id })) }); }
  if (u.startsWith('https://www.googleapis.com/drive/v3/files?fields=id') && m === 'POST') { const b = JSON.parse(init.body), id = who + '-F' + n++; D.set(id, { folder: true, name: b.name, parent: (b.parents || [])[0] }); return J({ id }); }
  if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) { const b = JSON.parse(init.body), id = who + '-P' + n++; D.set(id, { name: b.name, parent: b.parents[0], appProperties: b.appProperties, mime: h.get('X-Upload-Content-Type'), len: h.get('X-Upload-Content-Length') }); return new Response(null, { status: 200, headers: { Location: 'https://up.test/' + who + '/' + id } }); }
  if (u.startsWith('https://up.test/')) { const [, acc, id] = u.slice(8).split('/'); drives[acc].get(id).bytes = new Uint8Array(await new Response(init.body).arrayBuffer()).length; return J({ id }); }
  const fm = u.match(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^?]+)\?(.*)$/);
  if (fm) { const f = D.get(decodeURIComponent(fm[1])); if (!f) return J({ error: 'notFound' }, 404);
    if (fm[2].includes('alt=media')) return new Response(new Uint8Array(f.bytes || 5), { headers: { 'Content-Type': f.mime || 'image/jpeg', 'Content-Length': String(f.bytes || 5) } });
    return J({ id: fm[1], name: f.name, mimeType: f.mime || 'image/jpeg', size: String(f.bytes || 5), appProperties: f.appProperties }); }
  throw new Error('unexpected fetch ' + m + ' ' + u);
}
const req = (path, o = {}) => new Request('https://app.mutosstudio.com' + path, { method: o.body ? 'POST' : (o.method || 'GET'), headers: Object.assign({ 'Content-Type': 'application/json' }, o.tok ? { Authorization: 'Bearer ' + o.tok } : {}), body: o.body ? JSON.stringify(o.body) : undefined });
const call = async (path, o) => { const r = await photosApi(req(path, o), env, fakeFetch); const ct = r.headers.get('Content-Type') || ''; return { status: r.status, data: ct.includes('json') ? await r.json() : await r.text() }; };
const connect = async who => { nextLogin = who; _resetTokenCache(); const r = await call('/api/photos/connect', { tok: 'tok-owner', method: 'POST' }); const st = new URL(r.data.url).searchParams.get('state'); return call('/api/photos/callback?code=x&state=' + encodeURIComponent(st)); };

// connected to the old Gmail; photos were added there
await connect('old');
const oldRoot = JSON.parse(kv.get('gdrive:auth')).root;
const addOld = (kind, extra) => { const id = 'old-P' + n++, th = 'old-P' + n++; drives.old.set(id, { name: kind + ' photo', parent: oldRoot, mime: 'image/jpeg', bytes: 1200 }); drives.old.set(th, { name: kind + ' small', parent: oldRoot, mime: 'image/jpeg', bytes: 90 });
  rows.push(Object.assign({ id: 'row' + rows.length, kind, purpose: kind === 'card' ? 'card' : 'ref', status: 'ok', drive_id: id, thumb_id: th, at: '2026-11-20T10:00:00Z', wedding_key: kind === 'client' ? 'w:sharma' : null }, extra)); };
addOld('client'); addOld('card'); addOld('client', { purpose: 'vip' }); addOld('person', { purpose: 'avatar' });
rows.push({ id: 'gone', kind: 'client', purpose: 'ref', status: 'ok', drive_id: 'old-deleted', thumb_id: null, at: '2026-11-21T10:00:00Z', wedding_key: 'w:sharma' });

// switch to the new Gmail (Connect a different Gmail, no Disconnect)
await connect('new');
let r = await call('/api/photos/status', { tok: 'tok-owner' });
ok(r.data.account === 'new.studio@gmail.com' && r.data.old && r.data.old.account === 'old.studio@gmail.com', 'after switching, Settings shows the new Gmail and remembers the old one');
r = await call('/api/photos/move', { tok: 'tok-man', body: { offset: 0 } });
ok(r.status === 403, 'only the admin can move the photos');
// a photo added after the switch is already in the new Drive
drives.new.set('new-X', { name: 'fresh', parent: 'x', bytes: 10 }); rows.push({ id: 'fresh', kind: 'client', purpose: 'ref', status: 'ok', drive_id: 'new-X', at: '2026-11-27T10:00:00Z', wedding_key: 'w:sharma' });
let off = 0, tot = { moved: 0, already: 0, missing: 0 }, calls = 0;
for (;;) { r = await call('/api/photos/move', { tok: 'tok-owner', body: { offset: off, batch: 3 } }); calls++; if (r.data.error) { ok(false, 'move error ' + r.data.error); break; }
  ['moved', 'already', 'missing'].forEach(k => { tot[k] += r.data[k]; }); off = r.data.next; if (r.data.done) break; }
ok(tot.moved === 4 && tot.already === 1 && tot.missing === 1 && calls === 2, 'Move: 4 photos copied, 1 already here, 1 not found in either Drive (in pieces of 3)');
ok(rows.filter(x => x.id.startsWith('row')).every(x => drives.new.has(x.drive_id) && drives.new.has(x.thumb_id)), 'every moved photo (and its small copy) now points at a file in the new Drive');
const fam = rows.find(x => x.id === 'row0'), famFile = drives.new.get(fam.drive_id), famDir = drives.new.get(famFile.parent);
ok(famFile.bytes === 1200 && famDir.name === 'Sharma' && drives.new.get(famDir.parent).name === 'Families', 'a family photo lands in Families / Sharma, whole');
const card = drives.new.get(rows.find(x => x.id === 'row1').drive_id); ok(drives.new.get(card.parent).name === '2026-11', 'a card photo lands in Cards / 2026-11');
ok(drives.old.has(fam.drive_id) === false && drives.old.size >= 9, 'the old Drive is left as it was (a backup)');
// moving again changes nothing
r = await call('/api/photos/move', { tok: 'tok-owner', body: { offset: 0, batch: 10 } });
ok(r.data.moved === 0 && r.data.already === 5, 'running it again: everything is already here');
// switching back to the old Gmail finds its first "Muto's app photos" folder (no second one)
const before = [...drives.old.values()].filter(f => f.folder && f.name === "Muto's app photos").length;
await connect('old');
ok(JSON.parse(kv.get('gdrive:auth')).root === oldRoot && [...drives.old.values()].filter(f => f.folder && f.name === "Muto's app photos").length === before, 'connecting a Gmail again uses its existing "Muto\'s app photos" folder');
await connect('new');
ok(JSON.parse(kv.get('gdrive:auth')).account === 'new.studio@gmail.com', 'back to the new Gmail');
r = await call('/api/photos/forget-old', { tok: 'tok-owner', method: 'POST' });
r = await call('/api/photos/status', { tok: 'tok-owner' });
ok(!r.data.old, '"Forget" removes the old Gmail from Settings');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
