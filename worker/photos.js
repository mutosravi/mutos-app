// Photos on the studio's Google Drive (14 Nov 2026, Ravi): card photos from the team, families' important-people and reference
// photos. Nothing is stored at Cloudflare or Supabase: the photo passes through this Worker straight into Drive, and Supabase only
// keeps a small row (supabase/026_photos.sql) saying which Drive file it is.
//
// The app uploads AS the studio Gmail (a service account has no Drive space of its own). One-time setup by the admin:
//   1. Google Cloud → APIs & Services → Credentials → OAuth client (Web application) with the redirect URI
//      https://app.mutosstudio.com/api/photos/callback ; the consent screen "In production" (else Google stops it after 7 days);
//      Drive API enabled.
//   2. Cloudflare → mutos-app → Settings → Variables and Secrets: GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET.
//   3. App → Settings → Photos on Google Drive → Connect, and sign in with the studio Gmail.
// The scope is drive.file: the app sees ONLY the files and folders it made itself, nothing else in that Drive.
// The refresh token stays in this Worker's KV (key gdrive:auth), never in the browser or GitHub.
//
// Routes (all need the person's sign-in, Authorization: Bearer <Supabase token>):
//   GET  /api/photos/status              desk: { configured, connected, account }
//   POST /api/photos/connect             admin: { url } → Google sign-in
//   GET  /api/photos/callback            Google comes back here (checked with a signed state)
//   POST /api/photos/disconnect          admin
//   POST /api/photos/upload              body = the photo; header X-Mutos-Photo = JSON { kind, ref, cards, purpose, event, note }
//   POST /api/photos/upload?thumb=<id>   body = the small copy of a photo the same person just added
//   GET  /api/photos/file/<id>?s=thumb   the photo (or its small copy), only for people who may see it (upload_check)
//   POST /api/photos/remove              { id } → off the list (the file stays in Drive)

const enc = new TextEncoder();
const SCOPE = 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email';
const MAX = 25 * 1024 * 1024;
const json = (o, status = 200) => Response.json(o, { status });
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}
const sbBase = env => String(env.SUPABASE_URL).replace(/\/+$/, '');
const tokenOf = request => (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');

// the signed-in person (Supabase) and their role
async function whoIs(request, env, fetchFn) {
  const token = tokenOf(request);
  if (!token) return null;
  const u = await fetchFn(sbBase(env) + '/auth/v1/user', { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + token } });
  if (!u.ok) return null;
  const email = String((await u.json()).email || '').toLowerCase();
  const r = await fetchFn(sbBase(env) + '/rest/v1/members?select=role&email=eq.' + encodeURIComponent(email), { headers: serverHeaders(env) });
  const m = r.ok ? (await r.json())[0] : null;
  return { email, token, role: m ? m.role : null };
}
function serverHeaders(env) {
  const key = env.SUPABASE_SECRET_KEY;
  return Object.assign({ apikey: key, 'Content-Type': 'application/json' }, String(key).startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {});
}
// a database function called AS the person (their own rules apply)
async function rpcAs(env, fetchFn, token, fn, args) {
  const r = await fetchFn(sbBase(env) + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch (e) {}
  if (!r.ok) return { error: (d && (d.message || d.error)) || 'database ' + r.status + (r.status === 404 ? ' (run 026_photos.sql in Supabase)' : '') };
  return d || {};
}
async function rowPatch(env, fetchFn, id, body) {
  const r = await fetchFn(sbBase(env) + '/rest/v1/uploads?id=eq.' + id, { method: 'PATCH', headers: Object.assign(serverHeaders(env), { Prefer: 'return=minimal' }), body: JSON.stringify(body) });
  if (!r.ok) throw new Error('database ' + r.status + ' ' + (await r.text()).slice(0, 200));
}
async function rowGet(env, fetchFn, id) {
  const r = await fetchFn(sbBase(env) + '/rest/v1/uploads?select=*&id=eq.' + id, { headers: serverHeaders(env) });
  return r.ok ? (await r.json())[0] || null : null;
}

// ---------- Google sign-in of the studio Gmail ----------
let tokenCache = null;   // { token, exp }
async function auth(env) { const raw = env.BACKUPS && await env.BACKUPS.get('gdrive:auth'); try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
export async function driveToken(env, fetchFn = fetch) {
  if (tokenCache && tokenCache.exp > Date.now() + 60e3) return tokenCache.token;
  const a = await auth(env);
  if (!a || !a.refresh) throw new Error('Google Drive is not connected yet (Settings → Photos on Google Drive).');
  const r = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GDRIVE_CLIENT_ID, client_secret: env.GDRIVE_CLIENT_SECRET, refresh_token: a.refresh, grant_type: 'refresh_token' }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error(d.error === 'invalid_grant' ? 'Google Drive sign-in has expired or was removed. The admin must connect it again (Settings → Photos on Google Drive).' : 'Google refused the sign-in (' + (d.error || r.status) + ').');
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3000) * 1000 };
  return tokenCache.token;
}
export function _resetTokenCache() { tokenCache = null; }

async function gdrive(env, fetchFn, url, init = {}) {
  const t = await driveToken(env, fetchFn);
  return fetchFn(url, Object.assign({}, init, { headers: Object.assign({ Authorization: 'Bearer ' + t }, init.headers || {}) }));
}
// a folder path under the app's root folder (made once, ids remembered in KV)
async function folderFor(env, fetchFn, path) {
  const a = await auth(env); let parent = a && a.root;
  if (!parent) throw new Error('Google Drive is not connected yet.');
  for (let i = 0; i < path.length; i++) {
    const name = String(path[i] || 'Other').slice(0, 100), key = 'gdrive:folder:' + parent + '/' + name;
    let id = await env.BACKUPS.get(key);
    if (!id) {
      const q = "name = '" + name.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' and '" + parent + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
      const s = await (await gdrive(env, fetchFn, 'https://www.googleapis.com/drive/v3/files?fields=files(id)&q=' + encodeURIComponent(q))).json().catch(() => ({}));
      id = s.files && s.files[0] && s.files[0].id;
      if (!id) {
        const r = await gdrive(env, fetchFn, 'https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }) });
        id = (await r.json().catch(() => ({}))).id;
        if (!id) throw new Error('Could not make the folder ' + name + ' on Google Drive (' + r.status + ').');
      }
      await env.BACKUPS.put(key, id);
    }
    parent = id;
  }
  return parent;
}
// put bytes on Drive (resumable session, then one PUT); returns the Drive file
async function putFile(env, fetchFn, meta, mime, bytes) {
  const init = await gdrive(env, fetchFn, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(bytes.byteLength) }, body: JSON.stringify(meta) });
  const at = init.headers.get('Location');
  if (!init.ok || !at) throw new Error('Google Drive did not accept the photo (' + init.status + ' ' + (await init.text()).slice(0, 160) + ').');
  const r = await fetchFn(at, { method: 'PUT', headers: { 'Content-Type': mime }, body: bytes });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error('The upload to Google Drive failed (' + r.status + '). Try again.');
  return d;
}
const imgSize = h => { const n = x => { const v = Number(h.get(x)); return v > 0 && v < 100000 ? Math.round(v) : null; }; return { width: n('X-Photo-Width'), height: n('X-Photo-Height') }; };

export async function photosApi(request, env, fetchFn = fetch) {
  const url = new URL(request.url), p = url.pathname.replace(/\/+$/, '');
  if (!env.SUPABASE_SECRET_KEY) return json({ error: 'The server is missing SUPABASE_SECRET_KEY.' }, 503);
  if (!env.BACKUPS) return json({ error: 'The server storage binding BACKUPS is missing.' }, 503);
  const configured = !!(env.GDRIVE_CLIENT_ID && env.GDRIVE_CLIENT_SECRET);

  // Google comes back here after the admin signed in with the studio Gmail
  if (p === '/api/photos/callback' && request.method === 'GET') {
    const page = (msg, ok) => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google Drive · Muto\'s</title>' +
      '<body style="font-family:system-ui;max-width:460px;margin:60px auto;padding:0 20px;color:#3a2a2f"><h2>' + (ok ? 'Google Drive is connected ✓' : 'Not connected') + '</h2><p>' + msg + '</p><p><a href="/board.html">Back to the app</a></p></body>',
      { status: ok ? 200 : 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
    if (!configured) return page('GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET are not set in Cloudflare.', false);
    const st = String(url.searchParams.get('state') || '').split('.'), exp = st[0], sig = st.length > 2 ? st[st.length - 1] : '', who = st.slice(1, -1).join('.');   // the Gmail may hold dots
    if (!sig || sig !== await hmac(env.GDRIVE_CLIENT_SECRET, exp + '.' + who) || Number(exp) < Date.now()) return page('This sign-in link is old or not from the app. Start again from Settings.', false);
    if (url.searchParams.get('error')) return page('Google said: ' + String(url.searchParams.get('error')).replace(/[<>&]/g, '') + '.', false);
    const r = await fetchFn('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GDRIVE_CLIENT_ID, client_secret: env.GDRIVE_CLIENT_SECRET, redirect_uri: url.origin + '/api/photos/callback', grant_type: 'authorization_code' }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.refresh_token) return page('Google did not give a lasting sign-in (' + (d.error || 'no refresh token') + '). Remove "Muto\'s" from the Gmail\'s Google Account → Security → Third-party access, then connect again.', false);
    const ui = await (await fetchFn('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + d.access_token } })).json().catch(() => ({}));
    const old = await auth(env) || {};
    const a = { refresh: d.refresh_token, account: String(ui.email || ''), by: decodeURIComponent(who), at: new Date().toISOString(), root: old.account === ui.email ? old.root : null };
    tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3000) * 1000 };
    if (!a.root) {   // the app's own folder in that Drive
      const f = await fetchFn('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { Authorization: 'Bearer ' + d.access_token, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: "Muto's app photos", mimeType: 'application/vnd.google-apps.folder' }) });
      a.root = (await f.json().catch(() => ({}))).id;
      if (!a.root) return page('Signed in, but could not make the folder "Muto\'s app photos" (' + f.status + '). Is the Google Drive API enabled in Google Cloud?', false);
    }
    await env.BACKUPS.put('gdrive:auth', JSON.stringify(a));
    return page('Photos now go to the folder <b>Muto\'s app photos</b> in the Google Drive of <b>' + a.account.replace(/[<>&]/g, '') + '</b>. You can close this page.', true);
  }

  const me = await whoIs(request, env, fetchFn);
  if (!me) return json({ error: 'Sign in again.' }, 401);
  const desk = ['owner', 'manager', 'supervisor'].includes(me.role);

  if (p === '/api/photos/status' && request.method === 'GET') {
    const a = await auth(env);
    return json({ configured, connected: !!(a && a.refresh), account: desk && a ? a.account : undefined, since: desk && a ? a.at : undefined });
  }
  if (p === '/api/photos/connect' && request.method === 'POST') {
    if (me.role !== 'owner') return json({ error: 'Only the admin can connect Google Drive.' }, 403);
    if (!configured) return json({ error: 'First add GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET in Cloudflare (mutos-app → Settings → Variables and Secrets).' }, 503);
    const exp = String(Date.now() + 15 * 60e3), who = encodeURIComponent(me.email), state = exp + '.' + who + '.' + await hmac(env.GDRIVE_CLIENT_SECRET, exp + '.' + who);
    const q = new URLSearchParams({ client_id: env.GDRIVE_CLIENT_ID, redirect_uri: url.origin + '/api/photos/callback', response_type: 'code', scope: SCOPE, access_type: 'offline', prompt: 'consent select_account', state });
    return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q });
  }
  if (p === '/api/photos/disconnect' && request.method === 'POST') {
    if (me.role !== 'owner') return json({ error: 'Only the admin can disconnect Google Drive.' }, 403);
    const a = await auth(env);
    if (a && a.refresh) await fetchFn('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(a.refresh), { method: 'POST' }).catch(() => {});
    await env.BACKUPS.put('gdrive:auth', JSON.stringify({ account: a && a.account, root: a && a.root, refresh: null, at: new Date().toISOString() }));
    tokenCache = null;
    return json({ ok: true });
  }

  if (p === '/api/photos/upload' && request.method === 'POST') {
    const mime = String(request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    const len = Number(request.headers.get('Content-Length') || 0);
    if (!/^image\/[a-z0-9.+-]+$/.test(mime)) return json({ error: 'Only photos can be added.' }, 415);
    if (len > MAX) return json({ error: 'This photo is too big (25 MB at most).' }, 413);
    const thumbFor = url.searchParams.get('thumb');
    if (thumbFor) {   // the small copy of a photo this person just added
      if (!/^[0-9a-f-]{36}$/i.test(thumbFor)) return json({ error: 'Unknown photo.' }, 400);
      const row = await rowGet(env, fetchFn, thumbFor);
      if (!row || row.by_email !== me.email || row.status !== 'ok' || row.thumb_id) return json({ error: 'Unknown photo.' }, 404);
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 2 * 1024 * 1024) return json({ error: 'The small copy is too big.' }, 413);
      const f = await putFile(env, fetchFn, { name: row.name + ' (small)', parents: [await folderFor(env, fetchFn, ['.small copies'])], appProperties: { mutos: row.id, small: '1' } }, mime, bytes);
      await rowPatch(env, fetchFn, row.id, { thumb_id: f.id });
      return json({ ok: true });
    }
    let info = {}; try { info = JSON.parse(decodeURIComponent(request.headers.get('X-Mutos-Photo') || '{}')); } catch (e) { return json({ error: 'Bad request.' }, 400); }
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return json({ error: 'The photo is empty.' }, 400);
    if (bytes.byteLength > MAX) return json({ error: 'This photo is too big (25 MB at most).' }, 413);
    try { await driveToken(env, fetchFn); } catch (e) { return json({ error: e.message }, 503); }   // before a row is made
    const begin = await rpcAs(env, fetchFn, me.token, 'upload_begin', { p_kind: info.kind || null, p_ref: info.ref || null, p_cards: Array.isArray(info.cards) ? info.cards.slice(0, 20) : null,
      p_purpose: info.purpose || null, p_event: info.event || null, p_name: String(info.name || 'photo').slice(0, 200), p_mime: mime, p_size: bytes.byteLength, p_note: info.note || null });
    if (begin.error) return json({ error: begin.error }, 400);
    const folder = await folderFor(env, fetchFn, begin.folder || ['Other']);
    const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic', 'image/heif': '.heif', 'image/webp': '.webp' }[mime] || '';
    const f = await putFile(env, fetchFn, { name: begin.name + ext, parents: [folder], description: (info.note || '').slice(0, 300) + ' · added by ' + me.email, appProperties: { mutos: begin.id } }, mime, bytes);
    await rowPatch(env, fetchFn, begin.id, Object.assign({ drive_id: f.id, status: 'ok', size: bytes.byteLength }, imgSize(request.headers)));
    return json({ id: begin.id });
  }

  const fm = p.match(/^\/api\/photos\/file\/([0-9a-f-]{36})$/i);
  if (fm && request.method === 'GET') {
    const small = url.searchParams.get('s') === 'thumb';
    const chk = await rpcAs(env, fetchFn, me.token, 'upload_check', { p_id: fm[1], p_thumb: small });
    if (chk.error || !chk.drive_id) return json({ error: chk.error || 'Not found.' }, 404);
    const r = await gdrive(env, fetchFn, 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(chk.drive_id) + '?alt=media');
    if (!r.ok) return json({ error: r.status === 404 ? 'This photo was deleted from Google Drive.' : 'Google Drive did not send the photo (' + r.status + ').' }, r.status === 404 ? 404 : 502);
    return new Response(r.body, { headers: { 'Content-Type': chk.mime || r.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'private, max-age=604800, immutable' } });
  }
  if (p === '/api/photos/remove' && request.method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const r = await rpcAs(env, fetchFn, me.token, 'upload_remove', { p_id: b.id });
    return json(r, r.error ? 400 : 200);
  }
  return json({ error: 'Not found' }, 404);
}
