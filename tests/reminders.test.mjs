// Evening reminder job: picks tomorrow's shoots, sends one encrypted notification per phone, cleans up dead sign-ups.
// Run: node tests/reminders.test.mjs   (the encryption itself is checked against an independent decoder separately)
import { runReminders, reminderFor, notifyDecisionApi, notifyDriveApi, notifyCardApi } from '../worker/index.js';
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
// memory card notices (014 + 015): given → receiver; accepted / not received → giver; office returns → owner and managers
{
  const B1 = '33333333-3333-4333-8333-333333333333', SHREY = '44444444-4444-4444-8444-444444444444', SUP = '55555555-5555-4555-8555-555555555555';
  const M = id => id.replace(/^.{8}/, '66666666');
  const moves = [
    { id: M('11111111-1111-4111-8111-111111111111'), batch: B1, card: 'k1', from_person: SUP, to_person: SHREY, status: 'pending', given_by: 'sup+1@x.com', note: 'Sharma', answered_by: null },
    { id: M('11111111-1111-4111-8111-111111111112'), batch: B1, card: 'k2', from_person: SUP, to_person: SHREY, status: 'pending', given_by: 'sup+1@x.com', note: 'Sharma', answered_by: null }];
  const people = [{ id: SHREY, name: 'Shrey', email: 'shrey@x.com', crew_keys: ['shrey'] }, { id: SUP, name: 'Vikas', email: 'sup+1@x.com', crew_keys: [] }];
  const members = [{ email: 'o@x.com', role: 'owner', person_key: null }, { email: 'm@x.com', role: 'manager', person_key: null }, { email: 'shrey@x.com', role: 'crew', person_key: 'shrey' }, { email: 'sup+1@x.com', role: 'supervisor', person_key: null }];
  const phones = [['https://push.test/shrey', 'shrey'], ['https://push.test/sup', 'email:sup+1@x.com'], ['https://push.test/owner', 'email:o@x.com'], ['https://push.test/mgr', 'email:m@x.com']];
  const subs = []; for (const [endpoint, person_key] of phones) subs.push(Object.assign({ endpoint, person_key, fails: 0 }, await phone()));
  const pushed = []; let who = 'sup+1@x.com';
  const vals = (u, col) => { const m = u.match(new RegExp('[?&]' + col + '=in\\.\\(([^)]*)\\)')); return m ? m[1].split(',').map(x => x.replace(/"/g, '')) : null; };
  const f4 = async (url, opt = {}) => {
    const u = decodeURIComponent(String(url));
    if (u.endsWith('/auth/v1/user')) { const t = (opt.headers.Authorization || '').slice(7); return t === 'x' ? { ok: false } : { ok: true, json: async () => ({ email: who }) }; }
    if (u.startsWith('https://push.test/')) { pushed.push(u); return { status: 201 }; }
    if (opt.method === 'PATCH' || opt.method === 'DELETE') return { ok: true };
    const j = d => ({ ok: true, json: async () => d });
    if (u.includes('/card_moves?')) { const ids = vals(u, 'id'); return j(u.includes('batch=eq.') ? moves.filter(m => u.includes('batch=eq.' + m.batch)) : moves.filter(m => ids.includes(m.id))); }
    if (u.includes('/cards?')) return j([{ id: 'k2', code: 'C10' }, { id: 'k1', code: 'C2' }].filter(k => vals(u, 'id').includes(k.id)));
    if (u.includes('/people?')) { const ids = vals(u, 'id'), mails = vals(u, 'email'), eq = u.match(/[?&](id|email)=eq\.([^&]*)/); return j(people.filter(p => ids ? ids.includes(p.id) : mails ? mails.includes(p.email) : eq ? p[eq[1]] === eq[2] : false)); }
    if (u.includes('/members?')) { const mails = vals(u, 'email'), roles = vals(u, 'role'); return j(members.filter(m => mails ? mails.includes(m.email) : roles ? roles.includes(m.role) : false)); }
    if (u.includes('/push_subs?')) { const keys = vals(u, 'person_key'); return j(subs.filter(x => keys.includes(x.person_key))); }
    return j([]);
  };
  const call = (tok, body) => notifyCardApi(new Request('https://app.test/api/notify-card', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), Object.assign({ SUPABASE_PUBLISHABLE_KEY: 'pub' }, env), f4);
  let r = await call('t', { kind: 'give', batch: B1 }), j = await r.json();
  ok(j.sent === 1 && pushed.join() === 'https://push.test/shrey', 'cards given: the team leader\'s phone gets one notice for the whole batch');
  who = 'shrey@x.com'; ok((await call('t', { kind: 'give', batch: B1 })).status === 403, 'only the giver can send the "given" notice');
  ok((await call('x', { kind: 'give', batch: B1 })).status === 401 && (await call('t', { kind: 'give', batch: 'bad' })).status === 400, 'fake sign-in or id refused');
  moves.forEach(m => { m.status = 'accepted'; m.answered_by = 'shrey@x.com'; }); pushed.length = 0;
  r = await call('t', { kind: 'answer', moves: moves.map(m => m.id) }); j = await r.json();
  ok(j.sent === 1 && pushed.join() === 'https://push.test/sup', 'accepted: the giver (supervisor, signed up by Gmail with a +) gets "Shrey accepted C2, C10"');
  who = 'sup+1@x.com'; ok((await call('t', { kind: 'answer', moves: moves.map(m => m.id) })).status === 403, 'only the person who answered sends that notice');
  // Shrey returns the cards to the office: owner and manager are told; then the owner marks one "not received"
  moves.forEach(m => Object.assign(m, { status: 'pending', from_person: SHREY, to_person: null, given_by: 'shrey@x.com', answered_by: null })); pushed.length = 0; who = 'shrey@x.com';
  r = await call('t', { kind: 'give', batch: B1 }); j = await r.json();
  ok(j.sent === 2 && pushed.sort().join() === 'https://push.test/mgr,https://push.test/owner', 'a return to the office notifies the owner and the manager');
  moves[0].status = 'declined'; moves[0].answered_by = 'o@x.com'; moves[1].status = 'accepted'; moves[1].answered_by = 'o@x.com'; pushed.length = 0; who = 'o@x.com';
  r = await call('t', { kind: 'answer', moves: moves.map(m => m.id) }); j = await r.json();
  ok(j.sent === 2 && pushed.every(x => x === 'https://push.test/shrey'), 'Shrey gets one notice for the accepted card and one for the card marked not received');
  moves.forEach(m => { m.status = 'pending'; }); pushed.length = 0; r = await call('t', { kind: 'answer', moves: moves.map(m => m.id) }); j = await r.json();
  ok(j.sent === 0, 'nothing sent for handovers not answered yet');
}
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
