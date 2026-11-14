// Photos on Google Drive (worker/photos.js), with fake Supabase, Google and KV. Run: node tests/photos.test.mjs
import { photosApi, _resetTokenCache } from '../worker/photos.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const SB = 'https://sb.test';
const kv = new Map();
const env = { SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: 'pub', SUPABASE_SECRET_KEY: 'sb_secret_x', GDRIVE_CLIENT_ID: 'cid', GDRIVE_CLIENT_SECRET: 'csecret',
  BACKUPS: { get: async k => kv.has(k) ? kv.get(k) : null, put: async (k, v) => { kv.set(k, v); } } };
const users = { 'tok-owner': ['o@x.com', 'owner'], 'tok-crew': ['c@x.com', 'crew'], 'tok-fam': ['fam@gmail.com', null] };
const rows = new Map(); const driveFiles = new Map(); let nextId = 1; const calls = [];
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: Object.assign({ 'Content-Type': 'application/json' }, h) });
async function fakeFetch(u, init = {}) {
  u = String(u); const h = new Headers(init.headers || {}); calls.push({ u, method: init.method || 'GET', h, body: init.body });
  if (u === SB + '/auth/v1/user') { const t = (h.get('Authorization') || '').slice(7); return users[t] ? J({ email: users[t][0] }) : J({}, 401); }
  if (u.startsWith(SB + '/rest/v1/members')) { const e = decodeURIComponent(u.split('email=eq.')[1]); const r = Object.values(users).find(x => x[0] === e); return J(r && r[1] ? [{ role: r[1] }] : []); }
  if (u === SB + '/rest/v1/rpc/upload_begin') {
    const a = JSON.parse(init.body), who = users[(h.get('Authorization') || '').slice(7)];
    if (a.p_kind === 'client' && who[0] !== 'fam@gmail.com') return J({ error: 'Only the family\'s registered Gmail can add photos.' });
    const id = '00000000-0000-0000-0000-00000000000' + nextId++; rows.set(id, { id, by_email: who[0], status: 'pending', name: 'Reference · 2026', thumb_id: null });
    return J({ id, folder: a.p_kind === 'card' ? ['Cards', '2026-11'] : ['Families', 'Bansal'], name: rows.get(id).name });
  }
  if (u === SB + '/rest/v1/rpc/upload_check') { const a = JSON.parse(init.body), who = users[(h.get('Authorization') || '').slice(7)]; const r = rows.get(a.p_id);
    return J(r && r.status === 'ok' && who[0] !== 'c@x.com' ? { drive_id: a.p_thumb ? r.thumb_id || r.drive_id : r.drive_id, mime: 'image/jpeg' } : { error: 'Not found.' }); }
  if (u.startsWith(SB + '/rest/v1/uploads?select=*')) { const id = u.split('id=eq.')[1]; return J(rows.has(id) ? [rows.get(id)] : []); }
  if (u.startsWith(SB + '/rest/v1/uploads?id=eq.') && init.method === 'PATCH') { const id = u.split('id=eq.')[1]; Object.assign(rows.get(id), JSON.parse(init.body)); return new Response(null, { status: 204 }); }
  if (u === 'https://oauth2.googleapis.com/token') { const p = new URLSearchParams(init.body);
    if (p.get('grant_type') === 'authorization_code') return J({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 });
    return p.get('refresh_token') === 'rt1' ? J({ access_token: 'at2', expires_in: 3600 }) : J({ error: 'invalid_grant' }, 400); }
  if (u === 'https://www.googleapis.com/oauth2/v2/userinfo') return J({ email: 'mutos.media@gmail.com' });
  if (u.startsWith('https://www.googleapis.com/drive/v3/files?fields=files')) return J({ files: [] });
  if (u === 'https://www.googleapis.com/drive/v3/files?fields=id' && init.method === 'POST') { const m = JSON.parse(init.body); const id = 'F' + nextId++; driveFiles.set(id, m); return J({ id }); }
  if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) { const m = JSON.parse(init.body); const id = 'P' + nextId++; driveFiles.set(id, Object.assign({ mime: h.get('X-Upload-Content-Type') }, m)); return new Response(null, { status: 200, headers: { Location: 'https://up.test/' + id } }); }
  if (u.startsWith('https://up.test/')) { const id = u.slice(16); driveFiles.get(id).bytes = init.body.byteLength; return J({ id }); }
  if (u.startsWith('https://www.googleapis.com/drive/v3/files/') && u.endsWith('?alt=media')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
  if (u.startsWith('https://oauth2.googleapis.com/revoke')) return J({});
  throw new Error('unexpected fetch ' + u);
}
const req = (path, o = {}) => new Request('https://app.mutosstudio.com' + path, Object.assign({ headers: Object.assign({}, o.tok ? { Authorization: 'Bearer ' + o.tok } : {}, o.headers || {}) }, o.method ? { method: o.method } : {}, o.body ? { body: o.body } : {}));
const call = async (path, o) => { const r = await photosApi(req(path, o), env, fakeFetch); const ct = r.headers.get('Content-Type') || ''; return { status: r.status, data: ct.includes('json') ? await r.json() : ct.includes('html') ? await r.text() : new Uint8Array(await r.arrayBuffer()) }; };

let r = await call('/api/photos/status', { tok: 'tok-owner' });
ok(r.data.configured && !r.data.connected, 'status: set up in Cloudflare, not connected yet');
r = await call('/api/photos/status');
ok(r.status === 401, 'not signed in: no answer');
r = await call('/api/photos/connect', { tok: 'tok-crew', method: 'POST' });
ok(r.status === 403, 'only the admin can connect Google Drive');
r = await call('/api/photos/connect', { tok: 'tok-owner', method: 'POST' });
const g = new URL(r.data.url);
ok(g.host === 'accounts.google.com' && g.searchParams.get('redirect_uri') === 'https://app.mutosstudio.com/api/photos/callback' && g.searchParams.get('access_type') === 'offline' && /drive\.file/.test(g.searchParams.get('scope')) && !/auth\/drive( |$)/.test(g.searchParams.get('scope')), 'admin gets the Google sign-in (offline, drive.file only: the app sees just its own files)');
r = await call('/api/photos/callback?code=abc&state=' + encodeURIComponent(g.searchParams.get('state').replace(/.$/, 'x')));
ok(r.status === 400 && !kv.get('gdrive:auth'), 'a forged sign-in link is refused');
r = await call('/api/photos/callback?code=abc&state=' + encodeURIComponent(g.searchParams.get('state')));
const a = JSON.parse(kv.get('gdrive:auth') || '{}');
ok(r.status === 200 && a.refresh === 'rt1' && a.account === 'mutos.media@gmail.com' && a.root && driveFiles.get(a.root).name === "Muto's app photos", 'callback: lasting sign-in kept in KV and the folder "Muto\'s app photos" made');
ok(!/rt1/.test(r.data), 'the refresh token is never shown on the page');
r = await call('/api/photos/status', { tok: 'tok-crew' });
ok(r.data.connected && r.data.account === undefined, 'status: connected (the team does not see which Gmail)');
_resetTokenCache();

// a family adds a reference photo
const photo = new Uint8Array(150000).fill(7);
r = await call('/api/photos/upload', { tok: 'tok-fam', method: 'POST', body: photo, headers: { 'Content-Type': 'image/jpeg', 'X-Mutos-Photo': encodeURIComponent(JSON.stringify({ kind: 'client', ref: 'tok', purpose: 'ref', note: 'stage' })), 'X-Photo-Width': '3000', 'X-Photo-Height': '2000' } });
const id = r.data.id, row = rows.get(id);
ok(r.status === 200 && row.status === 'ok' && row.drive_id && row.width === 3000 && row.size === 150000, 'family photo uploaded: row marked ok with the Drive file, size and pixels');
const f = driveFiles.get(row.drive_id), fam = [...driveFiles.entries()].find(([, m]) => m.name === 'Families'), bans = [...driveFiles.entries()].find(([, m]) => m.name === 'Bansal');
ok(f.bytes === 150000 && f.parents[0] === bans[0] && bans[1].parents[0] === fam[0] && fam[1].parents[0] === a.root && f.appProperties.mutos === id, 'on Drive in Muto\'s app photos / Families / Bansal, tagged with the row id');
ok(calls.some(x => x.u === 'https://oauth2.googleapis.com/token' && new URLSearchParams(x.body).get('grant_type') === 'refresh_token'), 'the Worker signs in to Drive with the kept refresh token');
const nFolders = [...driveFiles.values()].filter(m => m.mimeType === 'application/vnd.google-apps.folder').length;
await call('/api/photos/upload', { tok: 'tok-fam', method: 'POST', body: photo, headers: { 'Content-Type': 'image/jpeg', 'X-Mutos-Photo': encodeURIComponent(JSON.stringify({ kind: 'client', ref: 'tok', purpose: 'vip' })) } });
ok([...driveFiles.values()].filter(m => m.mimeType === 'application/vnd.google-apps.folder').length === nFolders, 'the second photo reuses the folders');
r = await call('/api/photos/upload?thumb=' + id, { tok: 'tok-fam', method: 'POST', body: new Uint8Array(30000), headers: { 'Content-Type': 'image/jpeg' } });
ok(r.status === 200 && rows.get(id).thumb_id && driveFiles.get(rows.get(id).thumb_id).appProperties.small === '1', 'the small copy is added for lists');
r = await call('/api/photos/upload?thumb=' + id, { tok: 'tok-owner', method: 'POST', body: new Uint8Array(3000), headers: { 'Content-Type': 'image/jpeg' } });
ok(r.status === 404, 'only the person who added a photo adds its small copy, once');
r = await call('/api/photos/upload', { tok: 'tok-crew', method: 'POST', body: photo, headers: { 'Content-Type': 'image/jpeg', 'X-Mutos-Photo': encodeURIComponent(JSON.stringify({ kind: 'client', ref: 'tok', purpose: 'ref' })) } });
ok(r.status === 400 && /family/.test(r.data.error), 'the database rules decide who may add (someone else: refused, nothing sent to Drive)');
r = await call('/api/photos/upload', { tok: 'tok-fam', method: 'POST', body: new Uint8Array(10), headers: { 'Content-Type': 'application/pdf' } });
ok(r.status === 415, 'only photos');
// viewing
r = await call('/api/photos/file/' + id + '?s=thumb', { tok: 'tok-owner' });
ok(r.status === 200 && r.data.length === 3 && calls.at(-1).u.includes(rows.get(id).thumb_id), 'the studio opens the small copy (streamed from Drive)');
r = await call('/api/photos/file/' + id, { tok: 'tok-crew' });
ok(r.status === 404, 'someone the rules do not allow gets nothing');
// disconnect
r = await call('/api/photos/disconnect', { tok: 'tok-owner', method: 'POST' });
ok(calls.some(x => x.u.startsWith('https://oauth2.googleapis.com/revoke')) && !JSON.parse(kv.get('gdrive:auth')).refresh, 'Disconnect tells Google and forgets the sign-in');
_resetTokenCache();
const before = rows.size;
r = await call('/api/photos/upload', { tok: 'tok-fam', method: 'POST', body: photo, headers: { 'Content-Type': 'image/jpeg', 'X-Mutos-Photo': encodeURIComponent(JSON.stringify({ kind: 'client', ref: 'tok', purpose: 'ref' })) } });
ok(r.status === 503 && /not connected/.test(r.data.error) && rows.size === before, 'after Disconnect nothing more is uploaded (and no row is made)');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
