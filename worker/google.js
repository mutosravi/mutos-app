// Reads the Team Alignment sheet with a read-only Google service account (secret GOOGLE_SERVICE_ACCOUNT = its JSON key).
// The sheet must be shared with the service account's email as Viewer.
const enc = new TextEncoder();
const b64u = buf => { let s = ''; new Uint8Array(buf).forEach(b => { s += String.fromCharCode(b); }); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };

function pemToDer(pem) {
  const body = String(pem).replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const bin = atob(body), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function parseServiceAccount(raw) {
  // forgiving: trims spaces, a stray BOM, wrapping quotes, curly quotes from text editors, or a base64-encoded file
  let t = String(raw == null ? '' : raw).replace(/^\uFEFF/, '').trim();
  if (/^["'].*["']$/s.test(t) && !t.startsWith('{')) t = t.slice(1, -1).trim();
  t = t.replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2018\u2019]/g, "'");
  if (!t.startsWith('{') && /^[A-Za-z0-9+/=\s]+$/.test(t)) { try { const d = atob(t.replace(/\s+/g, '')); if (d.trim().startsWith('{')) t = d.trim(); } catch (e) {} }
  let sa = null; try { sa = JSON.parse(t); } catch (e) { sa = null; }
  if (!sa) {
    const hint = t.includes('BEGIN PRIVATE KEY') && !t.startsWith('{') ? 'it looks like only the private key was pasted'
      : !t.startsWith('{') ? 'it does not start with { (starts with "' + t.slice(0, 3).replace(/[^\w{}\- ]/g, '?') + '…")'
      : !t.endsWith('}') ? 'it does not end with } (' + t.length + ' characters: the end is cut off)'
      : 'it is not valid JSON (' + t.length + ' characters)';
    throw new Error('GOOGLE_SERVICE_ACCOUNT is not the JSON key file: ' + hint + '. Open the downloaded .json file in a plain text editor, select all, copy, and paste it as the secret value.');
  }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT is JSON but not a service-account key (no client_email / private_key). Use the file from Service Accounts → Keys → Add key → JSON.');
  return sa;
}
let cached = null; // { email, token, exp }
export async function accessToken(sa, fetchFn = fetch, scope = 'https://www.googleapis.com/auth/drive.readonly') {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === sa.client_email && cached.exp - 60 > now) return cached.token;
  const head = b64u(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64u(enc.encode(JSON.stringify({ iss: sa.client_email, scope, aud: sa.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(head + '.' + claim));
  const r = await fetchFn(sa.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + head + '.' + claim + '.' + b64u(sig) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Google refused the service account: ' + (j.error_description || j.error || r.status));
  cached = { email: sa.client_email, token: j.access_token, exp: now + (j.expires_in || 3600) };
  return cached.token;
}
// the sheet as an .xlsx file, base64 (the same shape the board got from the Drive connector)
export async function exportSheetXlsx(sa, fileId, fetchFn = fetch) {
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(String(fileId))) throw new Error('Unknown sheet.');
  const token = await accessToken(sa, fetchFn);
  const r = await fetchFn('https://www.googleapis.com/drive/v3/files/' + fileId + '/export?mimeType=' + encodeURIComponent('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 404) throw Object.assign(new Error('The sheet is not shared with ' + sa.client_email + '. Open the sheet → Share → add that email as Viewer.'), { status: 404 });
  if (r.status === 403) { const t = await r.text(); throw Object.assign(new Error(/has not been used|disabled/i.test(t) ? 'Turn on the Google Drive API in Google Cloud (APIs & Services → Library).' : 'Google Drive refused: ' + t.slice(0, 160)), { status: 403 }); }
  if (!r.ok) throw new Error('Google Drive error ' + r.status);
  return b64(await r.arrayBuffer());
}
