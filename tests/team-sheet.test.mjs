// Team Alignment sync in the app: service-account sign-in to Google, sheet export, and who may ask for it.
// Run: node tests/team-sheet.test.mjs
import crypto from 'node:crypto';
import { teamSheetApi } from '../worker/index.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = { type: 'service_account', client_email: 'team-sheet-reader@mutos.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' };
const SHEET = '15za9GtTboQhwVuUCBbcyYYqZ0QmCQj7kC4fEU6GxwU4', XLSX = Buffer.from('PK\x03\x04fake xlsx bytes');
const roles = { 'o': 'owner', 'm': 'manager', 'c': 'crew', 'g': 'gear' };
let tokenCalls = 0, shared = true, apiOn = true;
const fetchFn = async (url, opt = {}) => {
  const u = new URL(url);
  if (u.pathname === '/auth/v1/user') { const t = opt.headers.Authorization.split(' ')[1]; return roles[t] ? { ok: true, json: async () => ({ email: t + '@x.com' }) } : { ok: false }; }
  if (u.pathname.endsWith('/members')) { const e = (u.searchParams.get('email') || '').replace('eq.', ''); const r = roles[e[0]]; return { ok: true, json: async () => r ? [{ role: r }] : [] }; }
  if (u.host === 'oauth2.googleapis.com') {
    tokenCalls++;
    const jwt = new URLSearchParams(opt.body).get('assertion'), [h, p, s] = jwt.split('.');
    const valid = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), publicKey, Buffer.from(s, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    ok(valid && claims.iss === sa.client_email && claims.scope === 'https://www.googleapis.com/auth/drive.readonly', 'service-account sign-in is correctly signed and read-only');
    return { ok: true, json: async () => ({ access_token: 'ya29.test', expires_in: 3600 }) };
  }
  if (u.host === 'www.googleapis.com') {
    ok(opt.headers.Authorization === 'Bearer ya29.test' && u.pathname.endsWith('/' + SHEET + '/export') && /spreadsheetml/.test(u.searchParams.get('mimeType')), 'asks Drive to export the sheet as Excel');
    if (!apiOn) return { ok: false, status: 403, text: async () => 'Google Drive API has not been used in project 123 before or it is disabled' };
    if (!shared) return { ok: false, status: 404, text: async () => 'not found' };
    return { ok: true, status: 200, arrayBuffer: async () => XLSX.buffer.slice(XLSX.byteOffset, XLSX.byteOffset + XLSX.length) };
  }
  throw new Error('unexpected ' + url);
};
const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'sb_secret_x', SUPABASE_PUBLISHABLE_KEY: 'pub', GOOGLE_SERVICE_ACCOUNT: JSON.stringify(sa) };
const call = (token, e = env, fileId = SHEET) => teamSheetApi(new Request('https://app.test/api/team-sheet', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: JSON.stringify({ fileId }) }), e, fetchFn);
let r = await call('o'); let j = await r.json();
ok(r.status === 200 && Buffer.from(j.content, 'base64').equals(XLSX), 'owner gets the sheet');
r = await call('m'); ok(r.status === 200, 'manager gets the sheet');
ok(tokenCalls === 1, 'Google sign-in is reused, not repeated for every sync');
for (const t of ['c', 'g']) ok((await call(t)).status === 403, roles[t] + ' cannot read the sheet');
ok((await call(null)).status === 401 && (await call('zz')).status === 401, 'signed-out or fake token refused');
ok((await call('o', env, '../../etc')).status === 502, 'only sheet ids accepted');
shared = false; r = await call('o'); j = await r.json(); ok(r.status === 404 && j.error.includes(sa.client_email), 'not shared yet: says which email to share with');
shared = true; apiOn = false; r = await call('o'); j = await r.json(); ok(/Turn on the Google Drive API/.test(j.error), 'Drive API off: says to turn it on');
apiOn = true;
r = await call('o', Object.assign({}, env, { GOOGLE_SERVICE_ACCOUNT: undefined })); ok(r.status === 503, 'no key yet: says what to add');
r = await call('o', Object.assign({}, env, { GOOGLE_SERVICE_ACCOUNT: 'not json' })); j = await r.json(); ok(/does not start with \{/.test(j.error) && !j.error.includes('PRIVATE'), 'pasted the wrong thing: says what is wrong');
r = await call('o', Object.assign({}, env, { GOOGLE_SERVICE_ACCOUNT: sa.private_key })); j = await r.json(); ok(/only the private key/.test(j.error) && !j.error.includes('MII'), 'only the key pasted: says so, without echoing the key');
r = await call('o', Object.assign({}, env, { GOOGLE_SERVICE_ACCOUNT: JSON.stringify(sa).slice(0, 500) })); j = await r.json(); ok(/cut off/.test(j.error), 'cut-off paste: says so');
const curly = JSON.stringify(sa, null, 2).replace(/"/g, (m, i) => i % 2 ? '\u201C' : '\u201D');
r = await call('o', Object.assign({}, env, { GOOGLE_SERVICE_ACCOUNT: curly })); ok(r.status === 200, 'curly quotes from a text editor are accepted');
r = await call('o', Object.assign({}, env, { GOOGLE_SERVICE_ACCOUNT: '\uFEFF  ' + JSON.stringify(sa, null, 2) + '\n' })); ok(r.status === 200, 'spaces and BOM around the file are accepted');
r = await call('o', Object.assign({}, env, { GOOGLE_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(sa)).toString('base64') })); ok(r.status === 200, 'base64 of the file is accepted');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
