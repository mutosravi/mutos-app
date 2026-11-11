// Team app server: serves the website (public/) and sends phone reminders.
// Every evening (cron in wrangler.jsonc) each crew member with a shoot tomorrow gets a notification.
// Needs two secrets in Cloudflare (Settings → Variables and Secrets): SUPABASE_SECRET_KEY and VAPID_PRIVATE_KEY.
import { sendPush } from './push.js';
import { runBackup, listAll } from './backup.js';
import { parseServiceAccount, exportSheetXlsx } from './google.js';

const pad = n => String(n).padStart(2, '0');
function istDate(offsetDays) { const d = new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 864e5); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }

function db(env, fetchFn) {
  const key = env.SUPABASE_SECRET_KEY;
  const headers = Object.assign({ apikey: key, 'Content-Type': 'application/json' }, String(key).startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {});
  const base = String(env.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/';
  return {
    async get(path) { const r = await fetchFn(base + path, { headers }); if (!r.ok) throw new Error('database ' + r.status + ' ' + (await r.text()).slice(0, 200)); return r.json(); },
    async patch(path, body) { await fetchFn(base + path, { method: 'PATCH', headers, body: JSON.stringify(body) }); },
    async del(path) { await fetchFn(base + path, { method: 'DELETE', headers }); }
  };
}
export const NOTICE_CRON = '*/5 * * * *';
export const BACKUP_CRON = '30 21 * * *'; // 21:30 UTC = 3:00 am in India
const vapidOf = env => ({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT });
const inList = keys => 'in.(' + keys.map(k => '"' + String(k).replace(/"/g, '') + '"').join(',') + ')';

// the reminder text for one person's shoots on one day
export function reminderFor(shoots, unconfirmed) {
  const one = shoots.length === 1, s = shoots[0];
  const title = one ? 'Tomorrow: ' + s.shoot : shoots.length + ' shoots tomorrow';
  const body = one
    ? [s.slot + (s.report ? ' · Report ' + s.report : ''), s.venue || 'Venue to be confirmed', s.gear && s.gear.length ? 'Gear: ' + s.gear.join(', ') : ''].filter(Boolean).join(' · ')
    : shoots.map(x => x.shoot + ' (' + x.slot + (x.report ? ', ' + x.report : '') + ')').join(' · ');
  return { title, body: body + (unconfirmed ? ' · Please confirm in the app.' : ''), tag: 'tomorrow-' + s.date, url: '/crew' };
}

async function deliver(env, store, subs, message, fetchFn) {
  let sent = 0;
  for (const sub of subs) {
    let status = 0;
    try { status = await sendPush(sub, message, vapidOf(env), fetchFn); } catch (e) { status = -1; }
    const ep = 'push_subs?endpoint=eq.' + encodeURIComponent(sub.endpoint);
    if (status === 404 || status === 410) await store.del(ep);                 // phone turned reminders off or reinstalled
    else if (status >= 200 && status < 300) { sent++; await store.patch(ep, { last_ok: new Date().toISOString(), fails: 0 }); }
    else await store.patch(ep, { fails: (sub.fails || 0) + 1 });
  }
  return sent;
}

export async function runReminders(env, fetchFn = fetch) {
  const store = db(env, fetchFn), day = istDate(1);
  const feeds = await store.get('crew_feed?select=person_key,name,data');
  const due = feeds.map(f => ({ key: f.person_key, shoots: ((f.data && f.data.shoots) || []).filter(s => s.date === day) })).filter(x => x.shoots.length);
  if (!due.length) return { day, people: 0, sent: 0 };
  const keys = due.map(x => x.key);
  const subs = await store.get('push_subs?select=endpoint,person_key,p256dh,auth,fails&person_key=' + encodeURIComponent(inList(keys)));
  const answers = await store.get('crew_status?select=person_key,event_id,confirm&person_key=' + encodeURIComponent(inList(keys)));
  let sent = 0;
  for (const p of due) {
    const mine = subs.filter(s => s.person_key === p.key); if (!mine.length) continue;
    const unconfirmed = p.shoots.some(s => !answers.find(a => a.person_key === p.key && a.event_id === s.id && a.confirm));
    sent += await deliver(env, store, mine, reminderFor(p.shoots, unconfirmed), fetchFn);
  }
  return { day, people: due.length, sent };
}

// "Send me a test" from the crew page: the caller proves who they are with their sign-in token
async function testPush(request, env, fetchFn = fetch) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const u = await fetchFn(String(env.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + token } });
  if (!u.ok) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const email = String((await u.json()).email || '').toLowerCase();
  const store = db(env, fetchFn);
  const [m] = await store.get('members?select=person_key&email=eq.' + encodeURIComponent(email));
  if (!m) return Response.json({ error: 'No login for this account.' }, { status: 403 });
  const subs = await store.get('push_subs?select=endpoint,person_key,p256dh,auth,fails&person_key=eq.' + encodeURIComponent(m.person_key || 'email:' + email));
  if (!subs.length) return Response.json({ error: 'Reminders are not on for this phone yet.' }, { status: 404 });
  const sent = await deliver(env, store, subs, m.person_key ? { title: 'Reminders are on ✓', body: 'You will get a message the evening before each shoot.', tag: 'test', url: '/crew' } : { title: 'Notifications are on ✓', body: 'You will get a message when cards are given to you or answered.', tag: 'test', url: '/cards.html' }, fetchFn);
  return Response.json({ sent });
}

// the owner only: who is calling, checked with their sign-in token and the team list
async function ownerOnly(request, env, fetchFn = fetch) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const u = await fetchFn(String(env.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + token } });
  if (!u.ok) return null;
  const email = String((await u.json()).email || '').toLowerCase();
  const [m] = await db(env, fetchFn).get('members?select=role&email=eq.' + encodeURIComponent(email));
  return m && m.role === 'owner' ? email : null;
}

// owner or manager: the Team Alignment sheet, read with the service account
export async function teamSheetApi(request, env, fetchFn = fetch) {
  if (!env.GOOGLE_SERVICE_ACCOUNT) return Response.json({ error: 'Team Alignment sync is not set up yet: add the GOOGLE_SERVICE_ACCOUNT secret in Cloudflare.' }, { status: 503 });
  if (!env.SUPABASE_SECRET_KEY) return Response.json({ error: 'The server is missing SUPABASE_SECRET_KEY.' }, { status: 503 });
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const u = await fetchFn(String(env.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + token } });
  if (!u.ok) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const email = String((await u.json()).email || '').toLowerCase();
  const [m] = await db(env, fetchFn).get('members?select=role&email=eq.' + encodeURIComponent(email));
  if (!m || !['owner', 'manager'].includes(m.role)) return Response.json({ error: 'Only the owner and managers can sync the sheet.' }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  try { return Response.json({ content: await exportSheetXlsx(parseServiceAccount(env.GOOGLE_SERVICE_ACCOUNT), body.fileId, fetchFn) }); }
  catch (e) { return Response.json({ error: String(e.message || e) }, { status: e.status === 404 ? 404 : 502 }); }
}

// owner or manager decided a not-available request: tell the crew member on their phone
export async function notifyDecisionApi(request, env, fetchFn = fetch) {
  if (!env.SUPABASE_SECRET_KEY || !env.VAPID_PRIVATE_KEY) return Response.json({ sent: 0, note: 'Phone notifications are not set up.' });
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const u = await fetchFn(String(env.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + token } });
  if (!u.ok) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const email = String((await u.json()).email || '').toLowerCase(), store = db(env, fetchFn);
  const [m] = await store.get('members?select=role&email=eq.' + encodeURIComponent(email));
  if (!m || !['owner', 'manager'].includes(m.role)) return Response.json({ error: 'Only the owner and managers decide requests.' }, { status: 403 });
  const { id, auto } = await request.json().catch(() => ({}));
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return Response.json({ error: 'Unknown request.' }, { status: 400 });
  const [r] = await store.get('crew_away?select=id,person_key,date,slot,status&id=eq.' + id);
  if (!r || !['approved', 'declined'].includes(r.status)) return Response.json({ sent: 0 });
  const day = new Date(r.date + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const msg = r.status === 'approved'
    ? { title: 'Day off approved ✓', body: day + ' (' + r.slot + '): ' + (auto ? 'you have been replaced on that shoot, so you are free.' : 'the studio approved it.') }
    : { title: 'Day off not approved', body: day + ' (' + r.slot + '): the studio needs you that day. Please call the studio.' };
  const subs = await store.get('push_subs?select=endpoint,person_key,p256dh,auth,fails&person_key=eq.' + encodeURIComponent(r.person_key));
  const sent = subs.length ? await deliver(env, store, subs, Object.assign(msg, { tag: 'away-' + r.id, url: '/crew?tab=away' }), fetchFn) : 0;
  return Response.json({ sent });
}

// a drive was given in the app: tell the person who has to accept it (or the drive keepers, for a return to the office)
export async function notifyDriveApi(request, env, fetchFn = fetch) {
  if (!env.SUPABASE_SECRET_KEY || !env.VAPID_PRIVATE_KEY) return Response.json({ sent: 0, note: 'Phone notifications are not set up.' });
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const u = await fetchFn(String(env.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + token } });
  if (!u.ok) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const email = String((await u.json()).email || '').toLowerCase(), store = db(env, fetchFn);
  const { id } = await request.json().catch(() => ({}));
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return Response.json({ error: 'Unknown handover.' }, { status: 400 });
  const [m] = await store.get('drive_moves?select=id,drive,from_person,to_person,status,given_by,note&id=eq.' + id);
  if (!m || m.status !== 'pending') return Response.json({ sent: 0 });
  if (m.given_by !== email) return Response.json({ error: 'Only the giver can send this notice.' }, { status: 403 });
  const [d] = await store.get('drives?select=name&id=eq.' + m.drive);
  // the receiver; for a return to the office: the drive keepers, the owner and the managers (any phone they signed up, 015)
  const who = m.to_person ? [{ id: m.to_person }] : await store.get('people?select=id&skills=cs.%7Bdata%7D&active=eq.true');
  const office = m.to_person ? [] : (await store.get('members?select=email&role=' + inListQ(['owner', 'manager']))).map(x => x.email);
  const [from] = m.from_person ? await store.get('people?select=name&id=eq.' + m.from_person) : [{ name: 'the office' }];
  const keys = await phoneKeys(store, office, who.map(p => p.id));
  if (!keys.length) return Response.json({ sent: 0, note: 'They have not turned on phone notices.' });
  const subs = await store.get('push_subs?select=endpoint,person_key,p256dh,auth,fails&person_key=' + inListQ(keys));
  const msg = { title: (m.to_person ? 'Drive for you: ' : 'Drive returned to the office: ') + ((d && d.name) || 'a drive'), body: (m.to_person ? 'From ' + ((from && from.name) || 'someone') : 'Returned to the office by ' + ((from && from.name) || 'someone')) + (m.note ? ' · ' + m.note : '') + '. Open the app and tap "I have it" once you have it.', tag: 'drive-' + m.id, url: '/mywork.html?tab=drives' };
  const sent = subs.length ? await deliver(env, store, subs, msg, fetchFn) : 0;
  return Response.json({ sent });
}

// memory cards (014_cards.sql): tell the receiver when cards are given (the owner and managers for a return to the office),
// and tell the giver when they are accepted or not. Phones are found by the person's board keys and their "email:<gmail>" sign-up.
const inListQ = keys => encodeURIComponent(inList(keys));   // emails can hold '+'
async function phoneKeys(store, emails, personIds) {
  const people = [];
  if (personIds.length) people.push(...await store.get('people?select=id,email,crew_keys&active=eq.true&id=' + inListQ(personIds)));
  const mails = [...new Set(emails.concat(people.map(p => p.email)).filter(Boolean).map(e => String(e).toLowerCase()))];
  if (mails.length) people.push(...await store.get('people?select=id,email,crew_keys&active=eq.true&email=' + inListQ(mails)));
  const members = mails.length ? await store.get('members?select=email,person_key&email=' + inListQ(mails)) : [];
  return [...new Set(people.flatMap(p => p.crew_keys || []).concat(members.map(m => m.person_key)).concat(mails.map(e => 'email:' + e)).filter(Boolean))];
}
export async function notifyCardApi(request, env, fetchFn = fetch) {
  if (!env.SUPABASE_SECRET_KEY || !env.VAPID_PRIVATE_KEY) return Response.json({ sent: 0, note: 'Phone notifications are not set up.' });
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const u = await fetchFn(String(env.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + token } });
  if (!u.ok) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const email = String((await u.json()).email || '').toLowerCase(), store = db(env, fetchFn);
  const body = await request.json().catch(() => ({})), isId = x => /^[0-9a-f-]{36}$/i.test(String(x));
  const nameOf = async id => { if (!id) return 'the office'; const [p] = await store.get('people?select=name&id=eq.' + id); return (p && p.name) || 'someone'; };
  const codesOf = async ids => (await store.get('cards?select=id,code&id=' + inListQ(ids))).map(k => k.code).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const list = (codes, n) => codes.slice(0, 6).join(', ') + (codes.length > 6 ? ' +' + (codes.length - 6) : '');
  let sent = 0;
  if (body.kind === 'give') {
    if (!isId(body.batch)) return Response.json({ error: 'Unknown handover.' }, { status: 400 });
    const moves = (await store.get('card_moves?select=id,card,from_person,to_person,status,given_by,note&batch=eq.' + body.batch)).filter(m => m.status === 'pending');
    if (!moves.length) return Response.json({ sent: 0 });
    if (moves.some(m => m.given_by !== email)) return Response.json({ error: 'Only the giver can send this notice.' }, { status: 403 });
    const m = moves[0], codes = await codesOf(moves.map(x => x.card)), from = await nameOf(m.from_person);
    const office = m.to_person ? [] : (await store.get('members?select=email&role=' + inListQ(['owner', 'manager']))).map(x => x.email);
    const keys = await phoneKeys(store, office, m.to_person ? [m.to_person] : []);
    const n = codes.length, msg = { title: (m.to_person ? n + ' card' + (n > 1 ? 's' : '') + ' for you' : n + ' card' + (n > 1 ? 's' : '') + ' back to the office') + ': ' + list(codes),
      body: 'From ' + from + (m.note ? ' · ' + m.note : '') + '. Open the app and tap "I have ' + (n > 1 ? 'them' : 'it') + '" once they are in your hand.', tag: 'cards-' + body.batch, url: '/cards.html' };
    const subs = keys.length ? await store.get('push_subs?select=endpoint,person_key,p256dh,auth,fails&person_key=' + inListQ(keys)) : [];
    sent = subs.length ? await deliver(env, store, subs, msg, fetchFn) : 0;
    return Response.json({ sent });
  }
  if (body.kind === 'answer') {
    const ids = (Array.isArray(body.moves) ? body.moves : []).filter(isId).slice(0, 200);
    if (!ids.length) return Response.json({ error: 'Unknown handover.' }, { status: 400 });
    const moves = (await store.get('card_moves?select=id,card,to_person,status,given_by,answered_by&id=' + inListQ(ids))).filter(m => ['accepted', 'declined'].includes(m.status));
    if (!moves.length) return Response.json({ sent: 0 });
    if (moves.some(m => m.answered_by !== email)) return Response.json({ error: 'Only the person who answered can send this notice.' }, { status: 403 });
    const [who] = await store.get('people?select=name&email=eq.' + encodeURIComponent(email));
    const by = (who && who.name) || (moves[0].to_person ? await nameOf(moves[0].to_person) : 'The office');
    const groups = new Map(); moves.forEach(m => { const k = m.given_by + '|' + m.status; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); });
    for (const [k, g] of groups) {
      const [giver, status] = k.split('|'); if (giver === email) continue;
      const codes = await codesOf(g.map(x => x.card)), yes = status === 'accepted';
      const msg = { title: by + (yes ? ' accepted ' : ' did not accept ') + list(codes), body: yes ? (codes.length > 1 ? 'They are' : 'It is') + ' now ' + by + '\'s responsibility.' : 'Marked "not received": ' + (codes.length > 1 ? 'the cards are' : 'the card is') + ' still counted with you. Please check.', tag: 'cards-ans-' + g[0].id, url: '/cards.html' };
      const keys = await phoneKeys(store, [giver], []);
      const subs = keys.length ? await store.get('push_subs?select=endpoint,person_key,p256dh,auth,fails&person_key=' + inListQ(keys)) : [];
      if (subs.length) sent += await deliver(env, store, subs, msg, fetchFn);
    }
    return Response.json({ sent });
  }
  return Response.json({ error: 'Unknown notice.' }, { status: 400 });
}

// new shoots (018_shoot_notices.sql): the database queues one row per shoot that appears in someone's list; this sends them,
// one message per person, and marks them sent. Called by the board right after it updates the crew pages, and by the evening run.
// one shoot notice as a line: "New: …", "Not on … any more", "Changed: … (date Tue 14 Nov → Wed 15 Nov · venue Taj → Clarks)"
export function shootNoticeText(n, today) {
  const day = d => d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
  const when = d => d === today ? 'TODAY' : d === addDays(today, 1) ? 'tomorrow' : day(d);
  const kind = n.kind || 'new', name = n.shoot || 'a shoot';
  if (kind === 'removed') return { title: 'Not on ' + name + ' any more', body: when(n.date) + (n.slot ? ' · ' + n.slot : '') + ': you have been taken off this shoot (swapped, or it was cancelled). You do not need to go.' };
  if (kind === 'changed') {
    const parts = [];
    if (n.old_date && n.old_date !== n.date) parts.push('Date: ' + day(n.old_date) + ' → ' + day(n.date));
    if ((n.old_slot || '') !== (n.slot || '')) parts.push('Time of day: ' + (n.old_slot || '-') + ' → ' + (n.slot || '-'));
    if ((n.old_report || '') !== (n.report || '')) parts.push('Report: ' + (n.old_report || '-') + ' → ' + (n.report || '-'));
    if ((n.old_venue || '') !== (n.venue || '')) parts.push('Venue: ' + (n.venue || 'to be confirmed'));
    return { title: 'Changed: ' + name + (n.date === today || n.date === addDays(today, 1) ? ' (' + when(n.date) + ')' : ''), body: (parts.join(' · ') || when(n.date)) + '. Open the app for details.' };
  }
  return { title: (n.date === today ? 'New shoot TODAY: ' : n.date === addDays(today, 1) ? 'New shoot tomorrow: ' : 'New shoot: ') + name,
    body: [day(n.date) + (n.slot ? ' · ' + n.slot : ''), n.report ? 'Report ' + n.report : '', n.venue || 'Venue to be confirmed', n.role ? 'Role: ' + n.role : ''].filter(Boolean).join(' · ') + '. Open the app to confirm.' };
}
function addDays(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
// new shoots, swaps and changes (018 + 019): the database queues one row per person per shoot; this sends them, one message per
// person (a few lines together when there are several), and marks them sent. Called by the board right after it updates the crew
// pages, every 5 minutes (cron) and by the evening run.
export async function flushShootNotices(env, fetchFn = fetch) {
  const store = db(env, fetchFn), today = istDate(0);
  const rows = await store.get('shoot_notices?select=*&sent_at=is.null&order=created_at.asc&limit=300');
  if (!rows.length) return { people: 0, sent: 0 };
  const byPerson = new Map(); rows.forEach(r => { if (!byPerson.has(r.person_key)) byPerson.set(r.person_key, []); byPerson.get(r.person_key).push(r); });
  let sent = 0;
  for (const [key, list] of byPerson) {
    // a shoot that was changed several times in a row: only the latest change counts; new + changed = new (with the latest details)
    const last = new Map(); list.sort((a, b) => a.id - b.id).forEach(r => { const p = last.get(r.event_id); last.set(r.event_id, p && p.kind === 'new' && r.kind === 'changed' ? Object.assign({}, r, { kind: 'new' }) : p && r.kind === 'changed' && p.kind === 'changed' ? Object.assign({}, r, { old_date: p.old_date, old_slot: p.old_slot, old_report: p.old_report, old_venue: p.old_venue }) : r); });
    const items = [...last.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const texts = items.map(n => shootNoticeText(n, today));
    const urgent = items.some(n => n.date === today || n.date === addDays(today, 1));
    const msg = texts.length === 1 ? texts[0]
      : { title: texts.length + ' updates to your shoots' + (urgent ? ' (some today/tomorrow)' : ''), body: texts.slice(0, 4).map(t => t.title).join(' · ') + (texts.length > 4 ? ' …' : '') + '. Open the app for details.' };
    const members = await store.get('members?select=email&person_key=eq.' + encodeURIComponent(key));
    const keys = [...new Set([key].concat(await phoneKeys(store, members.map(m => m.email), [])))];
    const subs = await store.get('push_subs?select=endpoint,person_key,p256dh,auth,fails&person_key=' + inListQ(keys));
    const n = subs.length ? await deliver(env, store, subs, Object.assign(msg, { tag: 'shoots-' + key + '-' + list[list.length - 1].id, url: '/crew.html' }), fetchFn) : 0;
    sent += n;
    await store.patch('shoot_notices?id=' + inListQ(list.map(x => x.id)), { sent_at: new Date().toISOString(), result: subs.length ? 'sent to ' + n + ' phone(s)' : 'notices not turned on' });
  }
  return { people: byPerson.size, sent };
}
export async function notifyShootsApi(request, env, fetchFn = fetch) {
  if (!env.SUPABASE_SECRET_KEY || !env.VAPID_PRIVATE_KEY) return Response.json({ sent: 0, note: 'Phone notifications are not set up.' });
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return Response.json({ error: 'Sign in first.' }, { status: 401 });
  const u = await fetchFn(String(env.SUPABASE_URL).replace(/\/+$/, '') + '/auth/v1/user', { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer ' + token } });
  if (!u.ok) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const email = String((await u.json()).email || '').toLowerCase();
  const [m] = await db(env, fetchFn).get('members?select=role&email=eq.' + encodeURIComponent(email));
  if (!m || !['owner', 'manager', 'supervisor'].includes(m.role)) return Response.json({ error: 'Only the studio sends shoot notices.' }, { status: 403 });
  return Response.json(await flushShootNotices(env, fetchFn));
}

export async function backupApi(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (!env.SUPABASE_SECRET_KEY) return Response.json({ error: 'The server is missing SUPABASE_SECRET_KEY (Cloudflare → Settings → Variables and Secrets).' }, { status: 503 });
  if (!env.BACKUPS) return Response.json({ error: 'Backup storage is not connected yet.' }, { status: 503 });
  if (!(await ownerOnly(request, env, fetchFn))) return Response.json({ error: 'Only the owner can open backups.' }, { status: 403 });
  if (url.pathname === '/api/backups' && request.method === 'GET') {
    const keys = [...await listAll(env, 'nightly/'), ...await listAll(env, 'monthly/'), ...await listAll(env, 'manual/')];
    return Response.json({ backups: keys.map(k => ({ name: k.name, ...(k.metadata || {}) })).sort((a, b) => String(b.at || b.name).localeCompare(String(a.at || a.name))) });
  }
  if (url.pathname === '/api/backups/now' && request.method === 'POST') return Response.json(await runBackup(env, 'manual', fetchFn));
  if (url.pathname === '/api/backups/file' && request.method === 'GET') {
    const name = url.searchParams.get('name') || '';
    if (!/^(photos\/)?(nightly|monthly|manual)\/[\d-]+$/.test(name)) return Response.json({ error: 'Unknown backup.' }, { status: 400 });
    const body = await env.BACKUPS.get(name);
    if (body == null) return Response.json({ error: 'That backup no longer exists.' }, { status: 404 });
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="mutos-backup-' + name.replace(/\//g, '-') + '.json"', 'Cache-Control': 'no-store' } });
  }
  return Response.json({ error: 'Not found' }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/push-test' && request.method === 'POST') {
      if (!env.SUPABASE_SECRET_KEY || !env.VAPID_PRIVATE_KEY) return Response.json({ error: 'Reminders are not set up on the server yet.' }, { status: 503 });
      try { return await testPush(request, env); } catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
    }
    if (url.pathname === '/api/notify-decision' && request.method === 'POST') {
      try { return await notifyDecisionApi(request, env); } catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
    }
    if (url.pathname === '/api/team-sheet' && request.method === 'POST') {
      try { return await teamSheetApi(request, env); } catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
    }
    if (url.pathname === '/api/notify-drive' && request.method === 'POST') {
      try { return await notifyDriveApi(request, env); } catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
    }
    if (url.pathname === '/api/notify-card' && request.method === 'POST') {
      try { return await notifyCardApi(request, env); } catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
    }
    if (url.pathname === '/api/notify-shoots' && request.method === 'POST') {
      try { return await notifyShootsApi(request, env); } catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
    }
    if (url.pathname.startsWith('/api/backups')) {
      try { return await backupApi(request, env); } catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    if (event.cron === NOTICE_CRON) {   // every 5 minutes: only the shoot notices (swaps, changes, family venues)
      if (!env.SUPABASE_SECRET_KEY || !env.VAPID_PRIVATE_KEY) return;
      ctx.waitUntil(flushShootNotices(env).then(r => { if (r.people) console.log('shoot notices', JSON.stringify(r)); }).catch(e => console.log('shoot notices failed', e)));
      return;
    }
    if (event.cron === BACKUP_CRON) {
      if (!env.SUPABASE_SECRET_KEY || !env.BACKUPS) { console.log('backup skipped: secret key or storage missing'); return; }
      ctx.waitUntil(runBackup(env, 'nightly').then(r => console.log('backup', JSON.stringify(r))));
      return;
    }
    if (!env.SUPABASE_SECRET_KEY || !env.VAPID_PRIVATE_KEY) { console.log('reminders skipped: secrets not set'); return; }
    ctx.waitUntil(runReminders(env).then(r => console.log('reminders', JSON.stringify(r))));
    ctx.waitUntil(flushShootNotices(env).then(r => console.log('new-shoot notices', JSON.stringify(r))).catch(e => console.log('new-shoot notices failed', e)));
  }
};
