// Team app server: serves the website (public/) and sends phone reminders.
// Every evening (cron in wrangler.jsonc) each crew member with a shoot tomorrow gets a notification.
// Needs two secrets in Cloudflare (Settings → Variables and Secrets): SUPABASE_SECRET_KEY and VAPID_PRIVATE_KEY.
import { sendPush } from './push.js';
import { runBackup, listAll } from './backup.js';
import { parseServiceAccount, exportSheetXlsx } from './google.js';
import { smsHook, otpReady } from './whatsapp.js';

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
  if (!m || !m.person_key) return Response.json({ error: 'No crew login for this account.' }, { status: 403 });
  const subs = await store.get('push_subs?select=endpoint,person_key,p256dh,auth,fails&person_key=eq.' + encodeURIComponent(m.person_key));
  if (!subs.length) return Response.json({ error: 'Reminders are not on for this phone yet.' }, { status: 404 });
  const sent = await deliver(env, store, subs, { title: 'Reminders are on ✓', body: 'You will get a message the evening before each shoot.', tag: 'test', url: '/crew' }, fetchFn);
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
    if (!/^(nightly|monthly|manual)\/[\d-]+$/.test(name)) return Response.json({ error: 'Unknown backup.' }, { status: 400 });
    const body = await env.BACKUPS.get(name);
    if (body == null) return Response.json({ error: 'That backup no longer exists.' }, { status: 404 });
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="mutos-backup-' + name.replace('/', '-') + '.json"', 'Cache-Control': 'no-store' } });
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
    if (url.pathname === '/api/sms-hook' && request.method === 'POST') {
      try { return await smsHook(request, env); } catch (e) { console.log('sms-hook', e); return Response.json({ error: { http_code: 500, message: 'Could not send the code. Please try again.' } }, { status: 500 }); }
    }
    if (url.pathname === '/api/otp-status') return Response.json({ ready: otpReady(env) }, { headers: { 'Cache-Control': 'no-store' } });
    if (url.pathname.startsWith('/api/backups')) {
      try { return await backupApi(request, env); } catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    if (event.cron === BACKUP_CRON) {
      if (!env.SUPABASE_SECRET_KEY || !env.BACKUPS) { console.log('backup skipped: secret key or storage missing'); return; }
      ctx.waitUntil(runBackup(env, 'nightly').then(r => console.log('backup', JSON.stringify(r))));
      return;
    }
    if (!env.SUPABASE_SECRET_KEY || !env.VAPID_PRIVATE_KEY) { console.log('reminders skipped: secrets not set'); return; }
    ctx.waitUntil(runReminders(env).then(r => console.log('reminders', JSON.stringify(r))));
  }
};
