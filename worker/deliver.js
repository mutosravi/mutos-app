// Editors hand over finished work (27 Nov 2026, Ravi; supabase/047_job_handover.sql): Editor → Muto's approves → family.
// The file never passes through this Worker: the Worker opens a resumable Google Drive upload (as the studio Gmail, in
// "Muto's app photos / Families / <client> / Deliveries") and the editor's browser sends the file straight to Google in pieces.
//
// Routes (Authorization: Bearer <Supabase token>):
//   POST /api/deliver/begin   { job, name, mime, size }  → { id, upload_url }   (the assigned editor, or the admin / manager)
//   POST /api/deliver/done    { id, file }               → { ok }               (after the last piece; checks the file on Drive)
//   POST /api/deliver/peek    { id }                     → { url }              (a 2-hour link to watch the file, for review)
//   GET  /api/deliver/stream/<id>?e=&s=                                         (that link: streams from Drive, seeking works)
//   POST /api/deliver/share   { job }                    → { link }             (admin / manager on Approve: "anyone with the link")
// Nightly (after the backup): unshareExpired() turns sharing off for delivery files past their "Download till" day.
import { whoIs, rpcAs, rowPatch, rowGet, serverHeaders, gdrive, folderFor, driveToken, hmac } from './photos.js';

const json = (o, status = 200) => Response.json(o, { status });
const sbBase = env => String(env.SUPABASE_URL).replace(/\/+$/, '');
const fileUrl = id => 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id);
const signKey = env => env.GDRIVE_CLIENT_SECRET || env.SUPABASE_SECRET_KEY;

async function sbGet(env, fetchFn, path) {
  const r = await fetchFn(sbBase(env) + '/rest/v1/' + path, { headers: serverHeaders(env) });
  if (!r.ok) throw new Error('database ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return r.json();
}

export async function deliverApi(request, env, fetchFn = fetch) {
  const url = new URL(request.url), p = url.pathname.replace(/\/+$/, '');
  if (!env.SUPABASE_SECRET_KEY || !env.BACKUPS) return json({ error: 'The server is not set up for uploads yet.' }, 503);

  // the review link (no sign-in header: a <video> cannot send one; the link itself is signed and lasts 2 hours)
  const sm = p.match(/^\/api\/deliver\/stream\/([0-9a-f-]{36})$/i);
  if (sm && request.method === 'GET') {
    const e = url.searchParams.get('e') || '', s = url.searchParams.get('s') || '';
    if (!s || Number(e) < Date.now() || s !== await hmac(signKey(env), 'peek.' + sm[1] + '.' + e)) return json({ error: 'This preview link has expired. Open it again from the app.' }, 403);
    const row = await rowGet(env, fetchFn, sm[1]);
    if (!row || row.kind !== 'job' || !row.drive_id) return json({ error: 'Not found.' }, 404);
    const range = request.headers.get('Range');
    const r = await gdrive(env, fetchFn, fileUrl(row.drive_id) + '?alt=media', { headers: range ? { Range: range } : {} });
    if (!r.ok && r.status !== 206) return json({ error: r.status === 404 ? 'The file was deleted from Google Drive.' : 'Google Drive did not send the file (' + r.status + ').' }, r.status === 404 ? 404 : 502);
    const h = new Headers({ 'Content-Type': row.mime || r.headers.get('Content-Type') || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store',
      'Content-Disposition': 'inline; filename="' + String(row.name || 'file').replace(/["\\\r\n]/g, '') + '"' });
    ['Content-Length', 'Content-Range'].forEach(k => { const v = r.headers.get(k); if (v) h.set(k, v); });
    return new Response(r.body, { status: r.status, headers: h });
  }

  const me = await whoIs(request, env, fetchFn);
  if (!me) return json({ error: 'Sign in again.' }, 401);
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

  if (p === '/api/deliver/begin' && request.method === 'POST') {
    try { await driveToken(env, fetchFn); } catch (e) { return json({ error: e.message }, 503); }
    const size = Number(body.size) || 0, mime = String(body.mime || '').toLowerCase() || 'application/octet-stream';
    const b = await rpcAs(env, fetchFn, me.token, 'job_upload_begin', { p_job: body.job, p_name: String(body.name || 'file').slice(0, 200), p_mime: mime, p_size: size });
    if (b.error) return json({ error: /job_upload_begin/.test(b.error) ? 'Run supabase/047_job_handover.sql in Supabase first.' : b.error }, 400);
    const folder = await folderFor(env, fetchFn, b.folder || ['Deliveries']);
    const origin = request.headers.get('Origin') || url.origin;
    const r = await gdrive(env, fetchFn, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(size), Origin: origin },
      body: JSON.stringify({ name: b.name, parents: [folder], description: 'Handed over by ' + me.email, appProperties: { mutos: b.id } }) });
    const at = r.headers.get('Location');
    if (!r.ok || !at) return json({ error: 'Google Drive did not accept the upload (' + r.status + ').' }, 502);
    return json({ id: b.id, upload_url: at });
  }

  if (p === '/api/deliver/done' && request.method === 'POST') {
    if (!/^[0-9a-f-]{36}$/i.test(String(body.id || '')) || !body.file) return json({ error: 'Bad request.' }, 400);
    const row = await rowGet(env, fetchFn, body.id);
    if (!row || row.kind !== 'job' || row.by_email !== me.email) return json({ error: 'Unknown upload.' }, 404);
    if (row.status === 'ok') return json({ ok: true });
    const r = await gdrive(env, fetchFn, fileUrl(body.file) + '?fields=id,size,appProperties');
    const f = await r.json().catch(() => ({}));
    if (!r.ok || !f.appProperties || f.appProperties.mutos !== row.id) return json({ error: 'The file did not reach Google Drive. Try again.' }, 400);
    await rowPatch(env, fetchFn, row.id, { drive_id: f.id, status: 'ok', size: Number(f.size) || row.size });
    return json({ ok: true });
  }

  if (p === '/api/deliver/peek' && request.method === 'POST') {
    const chk = await rpcAs(env, fetchFn, me.token, 'job_file', { p_upload: body.id });
    if (chk.error || !chk.drive_id) return json({ error: chk.error || 'Not found.' }, 404);
    const e = String(Date.now() + 2 * 3600e3);
    return json({ url: '/api/deliver/stream/' + body.id + '?e=' + e + '&s=' + await hmac(signKey(env), 'peek.' + body.id + '.' + e), mime: chk.mime, name: chk.name });
  }

  if (p === '/api/deliver/share' && request.method === 'POST') {
    if (!['owner', 'manager'].includes(me.role)) return json({ error: 'Only the admin or the manager can send work to a family.' }, 403);
    const [job] = await sbGet(env, fetchFn, 'work_jobs?select=id,hand_upload,review&id=eq.' + encodeURIComponent(body.job || ''));
    if (!job || !job.hand_upload) return json({ error: 'This job has no uploaded file.' }, 404);
    const row = await rowGet(env, fetchFn, job.hand_upload);
    if (!row || !row.drive_id) return json({ error: 'The file is not on Google Drive.' }, 404);
    const pr = await gdrive(env, fetchFn, fileUrl(row.drive_id) + '/permissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone', allowFileDiscovery: false }) });
    if (!pr.ok) return json({ error: 'Google Drive did not share the file (' + pr.status + ').' }, 502);
    const f = await (await gdrive(env, fetchFn, fileUrl(row.drive_id) + '?fields=webViewLink')).json().catch(() => ({}));
    return json({ link: f.webViewLink || 'https://drive.google.com/file/d/' + row.drive_id + '/view' });
  }
  return json({ error: 'Not found' }, 404);
}

// nightly: files past their "Download till" day are no longer shared (they stay in the studio's Drive)
export async function unshareExpired(env, fetchFn = fetch) {
  const today = new Date(Date.now() + 330 * 60e3).toISOString().slice(0, 10);
  let rows; try { rows = await sbGet(env, fetchFn, 'client_deliveries?select=id,upload&shared=is.true&upload=not.is.null&expires_on=lt.' + today); } catch (e) { return { error: e.message }; }
  let done = 0, failed = 0;
  for (const d of rows) {
    try {
      const up = await rowGet(env, fetchFn, d.upload);
      if (up && up.drive_id) {
        const r = await gdrive(env, fetchFn, fileUrl(up.drive_id) + '/permissions/anyoneWithLink', { method: 'DELETE' });
        if (!r.ok && r.status !== 404) { failed++; continue; }
      }
      await fetchFn(sbBase(env) + '/rest/v1/client_deliveries?id=eq.' + d.id, { method: 'PATCH', headers: Object.assign(serverHeaders(env), { Prefer: 'return=minimal' }), body: JSON.stringify({ shared: false }) });
      done++;
    } catch (e) { failed++; }
  }
  return { unshared: done, failed };
}
