// Sign-in codes on WhatsApp for the client page.
// Supabase (Authentication → Hooks → "Send SMS hook", HTTPS) calls POST /api/sms-hook with the phone and the 6-digit code;
// we check the call really came from Supabase, check the number is on a wedding's list, then send the code
// from Muto's WhatsApp Business number (Meta Cloud API, an approved "Authentication" template with a Copy code button).
// Secrets in Cloudflare: SMS_HOOK_SECRET (from Supabase, "v1,whsec_…"), WA_TOKEN (Meta system user token), WA_PHONE_ID.
// Vars (wrangler.jsonc): WA_TEMPLATE (template name), WA_LANG (its language code).
const enc = new TextEncoder();
const GRAPH = 'https://graph.facebook.com/v24.0/';

export function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.length === 10) d = '91' + d;
  if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1);
  return d;
}
export const otpReady = env => !!(env.SMS_HOOK_SECRET && env.WA_TOKEN && env.WA_PHONE_ID && env.SUPABASE_SECRET_KEY);

// Standard Webhooks signature (what Supabase uses for HTTP hooks): base64(HMAC-SHA256(secret, id.timestamp.body))
export async function verifyHook(secret, headers, body, nowMs = Date.now()) {
  const id = headers.get('webhook-id'), ts = headers.get('webhook-timestamp'), sig = headers.get('webhook-signature');
  if (!id || !ts || !sig) return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowMs / 1000 - Number(ts)) > 300) return false; // older than 5 minutes: replayed
  let keyBytes;
  try { keyBytes = Uint8Array.from(atob(String(secret).trim().replace(/^v1,/, '').replace(/^whsec_/, '')), ch => ch.charCodeAt(0)); } catch (e) { return false; }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(id + '.' + ts + '.' + body)));
  const want = btoa(String.fromCharCode(...mac));
  return sig.split(' ').some(part => {
    const [v, s] = part.split(',');
    if (v !== 'v1' || !s || s.length !== want.length) return false;
    let diff = 0; for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ want.charCodeAt(i);
    return diff === 0;
  });
}

export function waMessage(phone, otp, env) {
  const p = [{ type: 'text', text: otp }];
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'template',
    template: { name: env.WA_TEMPLATE || 'mutos_login', language: { code: env.WA_LANG || 'en' }, components: [{ type: 'body', parameters: p }, { type: 'button', sub_type: 'url', index: '0', parameters: p }] }
  };
}

const fail = (code, message) => Response.json({ error: { http_code: code, message } }, { status: code });

export async function smsHook(request, env, fetchFn = fetch) {
  if (!env.SMS_HOOK_SECRET) return fail(503, 'Phone sign-in is not set up yet. Please sign in with Gmail.');
  const body = await request.text();
  if (!(await verifyHook(env.SMS_HOOK_SECRET, request.headers, body))) return fail(401, 'This request did not come from Supabase.');
  let ev; try { ev = JSON.parse(body); } catch (e) { return fail(400, 'Bad request.'); }
  const phone = normPhone(ev.user && ev.user.phone), otp = String((ev.sms && ev.sms.otp) || '');
  if (!/^\d{11,15}$/.test(phone) || !/^\d{4,10}$/.test(otp)) return fail(400, 'Please check the phone number.');
  if (!env.WA_TOKEN || !env.WA_PHONE_ID || !env.SUPABASE_SECRET_KEY) return fail(503, 'Phone sign-in is not set up yet. Please sign in with Gmail.');
  // only numbers Muto's listed for a wedding get a message: costs nothing for strangers and keeps the WhatsApp number in good standing
  const key = env.SUPABASE_SECRET_KEY;
  const headers = Object.assign({ apikey: key }, String(key).startsWith('eyJ') ? { Authorization: 'Bearer ' + key } : {});
  const q = String(env.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/client_links?select=wedding_key&active=eq.true&limit=1&phones=cs.' + encodeURIComponent('{' + phone + '}');
  const lr = await fetchFn(q, { headers });
  if (!lr.ok) { console.log('sms-hook: database', lr.status, (await lr.text()).slice(0, 200)); return fail(500, 'Could not check the number. Please try again.'); }
  if (!(await lr.json()).length) return fail(403, 'This number is not on Muto\'s list. Send it to Muto\'s on WhatsApp, or sign in with Gmail.');
  const r = await fetchFn(GRAPH + encodeURIComponent(env.WA_PHONE_ID) + '/messages', {
    method: 'POST', headers: { Authorization: 'Bearer ' + env.WA_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(waMessage(phone, otp, env))
  });
  if (!r.ok) { console.log('sms-hook: WhatsApp', r.status, (await r.text()).slice(0, 400)); return fail(502, 'Could not send the WhatsApp code. Try again in a minute, or sign in with Gmail.'); }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
}
