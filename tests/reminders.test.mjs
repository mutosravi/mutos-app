// Evening reminder job: picks tomorrow's shoots, sends one encrypted notification per phone, cleans up dead sign-ups.
// Run: node tests/reminders.test.mjs   (the encryption itself is checked against an independent decoder separately)
import { runReminders, reminderFor, notifyDecisionApi, notifyDriveApi } from '../worker/index.js';
import { b64u } from '../worker/push.js';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const pad = n => String(n).padStart(2, '0');
const ist = o => { const d = new Date(Date.now() + 5.5 * 3600e3 + o * 864e5); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
const tmr = ist(1);
const vk = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
const env = { SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'sb_secret_x', VAPID_PUBLIC_KEY: b64u.enc(await crypto.subtle.exportKey('raw', vk.publicKey)), VAPID_PRIVATE_KEY: (await crypto.subtle.exportKey('jwk', vk.privateKey)).d, VAPID_SUBJECT: 'https://app.test' };
async function phone() { const k = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']); return { p256dh: b64u.enc(await crypto.subtle.exportKey('raw', k.publicKey)), auth: b64u.enc(crypto.getRandomValues(new Uint8Array(16))) }; }
const feeds = [
  { person_key: 'anurag', name: 'Anurag', data: { shoots: [{ id: 'e1', date: tmr, shoot: 'Akriti Mehndi', slot: 'Evening', report: '5:00 pm', venue: 'Taj, Gomti Nagar', gear: ['M3', '24-70'] }, { id: 'e9', date: ist(3), shoot: 'Later', slot: 'Morning' }] } },
  { person_key: 'basu', name: 'Basu', data: { shoots: [{ id: 'e2', date: tmr, shoot: 'Sharma Haldi', slot: 'Morning' }, { id: 'e3', date: tmr, shoot: 'Sharma Sangeet', slot: 'Evening', report: '6:00 pm' }] } },
  { person_key: 'nitesh', name: 'Nitesh', data: { shoots: [{ id: 'e4', date: ist(2), shoot: 'Not tomorrow', slot: 'Evening' }] } },
  { person_key: 'sahil', name: 'Sahil', data: { shoots: [{ id: 'e5', date: tmr, shoot: 'No phone signed up', slot: 'Evening' }] } }
];
const subs = [Object.assign({ endpoint: 'https://push.test/a1', person_key: 'anurag', fails: 0 }, await phone()), Object.assign({ endpoint: 'https://push.test/b1', person_key: 'basu', fails: 0 }, await phone()), Object.assign({ endpoint: 'https://push.test/b-gone', person_key: 'basu', fails: 0 }, await phone())];
const answers = [{ person_key: 'anurag', event_id: 'e1', confirm: 'yes' }];
const pushes = [], deleted = [], patched = [];
const fetchFn = async (url, opt = {}) => {
  const u = decodeURIComponent(url);
  if (u.startsWith('https://push.test/')) { pushes.push({ url, opt }); return { status: url.endsWith('gone') ? 410 : 201 }; }
  if (opt.method === 'DELETE') { deleted.push(u); return { ok: true }; }
  if (opt.method === 'PATCH') { patched.push(u); return { ok: true }; }
  ok(opt.headers.apikey === 'sb_secret_x' && !opt.headers.Authorization, 'database call uses the secret key header');
  const json = async () => u.includes('crew_feed') ? feeds : u.includes('push_subs') ? subs.filter(s => u.includes('"' + s.person_key + '"')) : answers;
  return { ok: true, json };
};
const r = await runReminders(env, fetchFn);
ok(r.day === tmr && r.people === 3, 'found 3 people with shoots tomorrow (' + r.day + ')');
ok(pushes.length === 3 && r.sent === 2, 'sent to 3 phones, 2 delivered (' + pushes.length + ', ' + r.sent + ')');
ok(!pushes.some(p => p.url.includes('nitesh')), 'nobody without a shoot tomorrow is notified');
const p0 = pushes[0].opt;
ok(p0.headers['Content-Encoding'] === 'aes128gcm' && /^vapid t=.+, k=/.test(p0.headers.Authorization) && p0.body.length > 86, 'encrypted, signed request');
ok(deleted.some(d => d.includes('b-gone')), 'dead sign-up removed');
ok(patched.filter(p => p.includes('a1') || p.includes('b1')).length === 2, 'delivered sign-ups marked ok');
const a = reminderFor(feeds[0].data.shoots.slice(0, 1), false), b = reminderFor(feeds[1].data.shoots, true);
console.log('  ', JSON.stringify(a)); console.log('  ', JSON.stringify(b));
ok(a.title === 'Tomorrow: Akriti Mehndi' && a.body.includes('Report 5:00 pm') && !a.body.includes('confirm'), 'single shoot text');
ok(b.title === '2 shoots tomorrow' && b.body.includes('Please confirm'), 'two shoots + confirm nudge');
// decision on a not-available request goes to the crew member's phone; only staff can send it
{
  const ID = '0b1f6a2e-1111-4c4c-8888-123456789abc';
  const rows = { [ID]: { id: ID, person_key: 'anurag', date: tmr, slot: 'Full day', status: 'approved' } };
  const pushed = [];
  const f2 = async (url, opt = {}) => {
    const u = decodeURIComponent(url);
    if (u.includes('/auth/v1/user')) { const t = opt.headers.Authorization.split(' ')[1]; return t === 'x' ? { ok: false } : { ok: true, json: async () => ({ email: t + '@x.com' }) }; }
    if (u.includes('/members?')) { const e = u.split('email=eq.')[1]; return { ok: true, json: async () => [{ role: e.startsWith('o@') ? 'owner' : 'crew' }] }; }
    if (u.includes('/crew_away?')) return { ok: true, json: async () => rows[ID] ? [rows[ID]] : [] };
    if (u.includes('/push_subs?')) return { ok: true, json: async () => subs.filter(s2 => s2.person_key === 'anurag') };
    if (u.startsWith('https://push.test/')) { pushed.push(url); return { status: 201 }; }
    return { ok: true, json: async () => ({}) };
  };
  const call = (tok, body) => notifyDecisionApi(new Request('https://app.test/api/notify-decision', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), Object.assign({ SUPABASE_PUBLISHABLE_KEY: 'pub' }, env), f2);
  let r = await call('o', { id: ID }); let j = await r.json();
  ok(r.status === 200 && j.sent === 1 && pushed.length === 1, 'owner decision is pushed to the crew member\'s phone');
  ok((await call('c', { id: ID })).status === 403, 'crew cannot send decisions');
  ok((await call('x', { id: ID })).status === 401, 'fake sign-in refused');
  ok((await call('o', { id: 'not-an-id' })).status === 400, 'only real request ids');
  rows[ID].status = 'pending'; r = await call('o', { id: ID }); j = await r.json(); ok(j.sent === 0, 'nothing sent while still pending');
}
// drive handover notice (008_drives.sql): only the giver can send it; it goes to the receiver's phones
{
  const MID = '22222222-2222-4222-8222-222222222222', SHREY = 'p-shrey', KUL = 'p-kul';
  const mv = { id: MID, drive: 'd1', from_person: KUL, to_person: SHREY, status: 'pending', given_by: 'kul@x.com', note: 'for Jyoti reel' };
  const phones = [Object.assign({ endpoint: 'https://push.test/s1', person_key: 'shrey-cine', fails: 0 }, await phone()), Object.assign({ endpoint: 'https://push.test/s2', person_key: 'other', fails: 0 }, await phone())];
  const pushed = [], asked = [];
  const f3 = async (url, opt = {}) => {
    const u = String(url); asked.push(u);
    if (u.endsWith('/auth/v1/user')) { const t = (opt.headers.Authorization || '').slice(7); return t === 'x' ? { ok: false } : { ok: true, json: async () => ({ email: t === 'k' ? 'kul@x.com' : 'shrey@x.com' }) }; }
    if (u.includes('/drive_moves?')) return { ok: true, json: async () => [mv] };
    if (u.includes('/drives?')) return { ok: true, json: async () => [{ name: 'M 1' }] };
    if (u.includes('/people?select=id,crew_keys&id=eq.' + SHREY)) return { ok: true, json: async () => [{ id: SHREY, crew_keys: ['shrey-cine', 'shrey-drone'] }] };
    if (u.includes('/people?select=id,crew_keys&skills=cs.')) return { ok: true, json: async () => [{ id: KUL, crew_keys: ['other'] }] };
    if (u.includes('/people?select=name')) return { ok: true, json: async () => [{ name: 'Kuldeep' }] };
    if (u.includes('/push_subs?')) { const keys = decodeURIComponent(u.split('person_key=')[1]); return { ok: true, json: async () => phones.filter(x => keys.includes('"' + x.person_key + '"')) }; }
    if (u.startsWith('https://push.test/')) { pushed.push(u); return { status: 201 }; }
    return { ok: true, json: async () => ({}) };
  };
  const call = (tok, body) => notifyDriveApi(new Request('https://app.test/api/notify-drive', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), Object.assign({ SUPABASE_PUBLISHABLE_KEY: 'pub' }, env), f3);
  let r = await call('k', { id: MID }), j = await r.json();
  ok(r.status === 200 && j.sent === 1 && pushed[0] === 'https://push.test/s1', 'drive given: the receiver\'s phone gets the notice (any of their crew roles)');
  ok((await call('s', { id: MID })).status === 403, 'only the giver can send the drive notice');
  ok((await call('x', { id: MID })).status === 401 && (await call('k', { id: 'bad' })).status === 400, 'fake sign-in or id refused');
  mv.to_person = null; pushed.length = 0; r = await call('k', { id: MID }); j = await r.json();
  ok(j.sent === 1 && pushed[0] === 'https://push.test/s2', 'a return to the office notifies the drive keepers');
  mv.status = 'accepted'; r = await call('k', { id: MID }); j = await r.json(); ok(j.sent === 0, 'nothing sent once it is answered');
}
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
