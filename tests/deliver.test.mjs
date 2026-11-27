// Editors hand over work (worker/deliver.js), with fake Supabase, Google and KV. Run: node tests/deliver.test.mjs
import { deliverApi, unshareExpired } from '../worker/deliver.js';
import { _resetTokenCache } from '../worker/photos.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const SB = 'https://sb.test';
const kv = new Map([['gdrive:auth', JSON.stringify({ refresh: 'rt1', root: 'ROOT', account: 'studio@gmail.com' })]]);
const env = { SUPABASE_URL: SB, SUPABASE_PUBLISHABLE_KEY: 'pub', SUPABASE_SECRET_KEY: 'sb_secret_x', GDRIVE_CLIENT_ID: 'cid', GDRIVE_CLIENT_SECRET: 'csecret',
  BACKUPS: { get: async k => kv.has(k) ? kv.get(k) : null, put: async (k, v) => { kv.set(k, v); } } };
const users = { 'tok-owner': ['o@x.com', 'owner'], 'tok-ed': ['ed@x.com', 'staff'], 'tok-ed2': ['ed2@x.com', 'staff'], 'tok-sup': ['s@x.com', 'supervisor'] };
const uploads = new Map(), drive = new Map(), perms = []; let n = 1;
const jobs = { J1: { id: 'J1', hand_upload: null, review: null } };
const deliveries = [{ id: 'D1', upload: null, shared: true, expires_on: '2020-01-01' }];
const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: Object.assign({ 'Content-Type': 'application/json' }, h) });
const who = h => users[(h.get('Authorization') || '').slice(7)] || [];
async function fakeFetch(u, init = {}) {
  u = String(u); const h = new Headers(init.headers || {}), m = init.method || 'GET';
  if (u === SB + '/auth/v1/user') return users[(h.get('Authorization') || '').slice(7)] ? J({ email: who(h)[0] }) : J({}, 401);
  if (u.startsWith(SB + '/rest/v1/members')) { const e = decodeURIComponent(u.split('email=eq.')[1]); const r = Object.values(users).find(x => x[0] === e); return J(r ? [{ role: r[1] }] : []); }
  if (u === SB + '/rest/v1/rpc/job_upload_begin') { const a = JSON.parse(init.body);
    if (who(h)[0] === 'ed2@x.com') return J({ error: 'Only the editor this job is assigned to can hand it over.' });
    const id = '00000000-0000-0000-0000-0000000000' + String(n++).padStart(2, '0'); uploads.set(id, { id, kind: 'job', by_email: who(h)[0], status: 'pending', size: a.p_size, mime: a.p_mime, name: 'Reel · round 1' });
    return J({ id, folder: ['Families', 'Sharma', 'Deliveries'], name: 'Reel · round 1.mp4' }); }
  if (u === SB + '/rest/v1/rpc/job_file') { const a = JSON.parse(init.body), r = uploads.get(a.p_upload);
    return J(r && r.status === 'ok' && ['o@x.com', 'ed@x.com'].includes(who(h)[0]) ? { drive_id: r.drive_id, mime: r.mime, name: r.name } : { error: 'Not found.' }); }
  if (u.startsWith(SB + '/rest/v1/uploads?select=*')) { const id = u.split('id=eq.')[1]; return J(uploads.has(id) ? [uploads.get(id)] : []); }
  if (u.startsWith(SB + '/rest/v1/uploads?id=eq.') && m === 'PATCH') { Object.assign(uploads.get(u.split('id=eq.')[1]), JSON.parse(init.body)); return new Response(null, { status: 204 }); }
  if (u.startsWith(SB + '/rest/v1/work_jobs?')) { const id = decodeURIComponent(u.split('id=eq.')[1]); return J(jobs[id] ? [jobs[id]] : []); }
  if (u.startsWith(SB + '/rest/v1/client_deliveries?select=')) return J(deliveries.filter(d => d.shared && d.upload && d.expires_on < '2026-11-27'));
  if (u.startsWith(SB + '/rest/v1/client_deliveries?id=eq.') && m === 'PATCH') { Object.assign(deliveries.find(d => d.id === u.split('id=eq.')[1]), JSON.parse(init.body)); return new Response(null, { status: 204 }); }
  if (u === 'https://oauth2.googleapis.com/token') return J({ access_token: 'at', expires_in: 3600 });
  if (u.startsWith('https://www.googleapis.com/drive/v3/files?fields=files')) return J({ files: [] });
  if (u === 'https://www.googleapis.com/drive/v3/files?fields=id' && m === 'POST') { const id = 'FOLDER' + n++; return J({ id }); }
  if (u.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable')) {
    const meta = JSON.parse(init.body), id = 'DF' + n++; drive.set(id, { meta, origin: h.get('Origin'), len: h.get('X-Upload-Content-Length'), type: h.get('X-Upload-Content-Type') });
    return new Response(null, { status: 200, headers: { Location: 'https://up.test/' + id } }); }
  const fm = u.match(/^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)(\/permissions(\/anyoneWithLink)?)?(\?.*)?$/);
  if (fm) { const f = drive.get(fm[1]);
    if (fm[2] && m === 'POST') { perms.push({ file: fm[1], body: JSON.parse(init.body) }); return J({ id: 'anyoneWithLink' }); }
    if (fm[3] && m === 'DELETE') { perms.push({ file: fm[1], removed: true }); return new Response(null, { status: 204 }); }
    if (!f) return J({}, 404);
    if ((fm[4] || '').includes('alt=media')) { const rg = h.get('Range'); return new Response(new Uint8Array([1, 2, 3]), { status: rg ? 206 : 200, headers: Object.assign({ 'Content-Type': 'video/mp4', 'Content-Length': '3' }, rg ? { 'Content-Range': 'bytes 0-2/100' } : {}) }); }
    if ((fm[4] || '').includes('webViewLink')) return J({ webViewLink: 'https://drive.google.com/file/d/' + fm[1] + '/view' });
    return J({ id: fm[1], size: '524288000', appProperties: f.meta.appProperties }); }
  throw new Error('unexpected fetch ' + m + ' ' + u);
}
const req = (path, o = {}) => new Request('https://app.mutosstudio.com' + path, { method: o.body ? 'POST' : 'GET',
  headers: Object.assign({ 'Content-Type': 'application/json', Origin: 'https://app.mutosstudio.com' }, o.tok ? { Authorization: 'Bearer ' + o.tok } : {}, o.headers || {}), body: o.body ? JSON.stringify(o.body) : undefined });
const call = async (path, o) => { const r = await deliverApi(req(path, o), env, fakeFetch); const ct = r.headers.get('Content-Type') || ''; return { status: r.status, r, data: ct.includes('json') ? await r.json() : null }; };
_resetTokenCache();

let r = await call('/api/deliver/begin', { body: { job: 'J1', name: 'reel.mp4', mime: 'video/mp4', size: 524288000 } });
ok(r.status === 401, 'not signed in: refused');
r = await call('/api/deliver/begin', { tok: 'tok-ed2', body: { job: 'J1', name: 'reel.mp4', mime: 'video/mp4', size: 524288000 } });
ok(r.status === 400 && /assigned/.test(r.data.error), 'another editor cannot start an upload for this job');
r = await call('/api/deliver/begin', { tok: 'tok-ed', body: { job: 'J1', name: 'reel.mp4', mime: 'video/mp4', size: 524288000 } });
const up = r.data, df = String(up.upload_url).slice(16), d = drive.get(df);
ok(r.status === 200 && /^https:\/\/up\.test\//.test(up.upload_url) && d.origin === 'https://app.mutosstudio.com' && d.len === '524288000' && d.type === 'video/mp4', 'begin: a Drive upload the browser can send to (opened for the app\'s address, 500 MB video)');
ok(d.meta.appProperties.mutos === up.id && d.meta.parents.length === 1, 'the Drive file is tagged with the upload and goes into the client\'s Deliveries folder');
r = await call('/api/deliver/done', { tok: 'tok-ed2', body: { id: up.id, file: df } });
ok(r.status === 404, 'only the person who uploaded can finish it');
r = await call('/api/deliver/done', { tok: 'tok-ed', body: { id: up.id, file: 'SOMEOTHER' } });
ok(r.status === 400 && uploads.get(up.id).status === 'pending', 'a file that is not this upload is refused');
r = await call('/api/deliver/done', { tok: 'tok-ed', body: { id: up.id, file: df } });
ok(r.status === 200 && uploads.get(up.id).status === 'ok' && uploads.get(up.id).drive_id === df, 'done: checked on Drive, the upload is marked ok');

// review: a signed 2-hour link that streams (seeking works)
r = await call('/api/deliver/peek', { tok: 'tok-sup', body: { id: up.id } });
ok(r.status === 404, 'the supervisor cannot preview (only the editor, admin or manager)');
r = await call('/api/deliver/peek', { tok: 'tok-owner', body: { id: up.id } });
const link = r.data.url;
ok(r.status === 200 && /^\/api\/deliver\/stream\/.+\?e=\d+&s=/.test(link), 'the admin gets a preview link');
r = await call(link, { headers: { Range: 'bytes=0-' } });
ok(r.status === 206 && r.r.headers.get('Content-Range') === 'bytes 0-2/100' && r.r.headers.get('Accept-Ranges') === 'bytes' && /inline/.test(r.r.headers.get('Content-Disposition')), 'the preview link plays (206, seeking)');
r = await call(link.slice(0, -1) + (link.endsWith('A') ? 'B' : 'A'));
ok(r.status === 403, 'a changed link is refused');
r = await call(link.replace(/e=\d+/, 'e=1'));
ok(r.status === 403, 'an old link is refused');

// approve: share
r = await call('/api/deliver/share', { tok: 'tok-ed', body: { job: 'J1' } });
ok(r.status === 403, 'an editor cannot share to the family');
r = await call('/api/deliver/share', { tok: 'tok-owner', body: { job: 'J1' } });
ok(r.status === 404, 'no uploaded file on the job yet: nothing to share');
jobs.J1.hand_upload = up.id; jobs.J1.review = 'waiting';
r = await call('/api/deliver/share', { tok: 'tok-owner', body: { job: 'J1' } });
ok(r.status === 200 && r.data.link === 'https://drive.google.com/file/d/' + df + '/view' && perms.some(p => p.file === df && p.body.type === 'anyone' && p.body.role === 'reader'), 'admin approves: the file is shared "anyone with the link" (view only) and its link comes back');

// nightly: past "Download till" → no longer shared
deliveries[0].upload = up.id;
const u = await unshareExpired(env, fakeFetch);
ok(u.unshared === 1 && perms.some(p => p.file === df && p.removed) && deliveries[0].shared === false, 'nightly: an expired delivery file is unshared (it stays in Drive)');

console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
