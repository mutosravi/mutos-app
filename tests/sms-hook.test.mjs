// Test for worker/whatsapp.js: run `node tests/sms-hook.test.mjs`
import crypto from 'node:crypto';
import worker from '../worker/index.js';
import { normPhone, verifyHook, waMessage } from '../worker/whatsapp.js';

let failed = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) failed++; };
const RAW = crypto.randomBytes(32), SECRET = 'v1,whsec_' + RAW.toString('base64');
const sign = (id, ts, body, raw = RAW) => 'v1,' + crypto.createHmac('sha256', raw).update(id + '.' + ts + '.' + body).digest('base64');
const LISTED = '919876543210';
function req(payload, opts = {}) {
  const body = JSON.stringify(payload), id = 'msg_' + crypto.randomUUID(), ts = String(opts.ts || Math.floor(Date.now() / 1000));
  const h = { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': opts.sig || ('v1,bm90LXRoaXM= ' + sign(id, ts, body, opts.raw)), 'content-type': 'application/json' };
  return new Request('https://mutos-app.example/api/sms-hook', { method: 'POST', headers: h, body: opts.tamper ? body.replace('123456', '999999') : body });
}
const env = { SUPABASE_URL: 'https://db.example', SUPABASE_SECRET_KEY: 'sb_secret_x', SMS_HOOK_SECRET: SECRET, WA_TOKEN: 'tok', WA_PHONE_ID: '1122', WA_TEMPLATE: 'mutos_login', WA_LANG: 'en', ASSETS: { fetch: () => new Response('asset') } };
let calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (String(url).startsWith('https://db.example/rest/v1/client_links')) {
    const m = decodeURIComponent(String(url)).match(/phones=cs\.\{(\d+)\}/);
    return Response.json(m && m[1] === LISTED ? [{ wedding_key: 'w:akriti' }] : []);
  }
  if (String(url).startsWith('https://graph.facebook.com/')) return env.__waDown ? new Response('{"error":{"message":"down"}}', { status: 500 }) : Response.json({ messages: [{ id: 'wamid.1' }] });
  return new Response('?', { status: 404 });
};
const run = async (r, e = env) => { calls = []; const res = await worker.fetch(r, e); let j = null; try { j = JSON.parse(await res.text()); } catch (x) {} return { status: res.status, j }; };
const payload = phone => ({ user: { id: 'u1', phone }, sms: { otp: '123456' } });

ok(normPhone('+91 98765-43210') === LISTED && normPhone('09876543210') === LISTED && normPhone('9876543210') === LISTED && normPhone('919876543210') === LISTED, 'numbers are written one way');
let r = await run(req(payload('+' + LISTED)));
const wa = calls.find(c => c.url.startsWith('https://graph.facebook.com/'));
ok(r.status === 200 && wa, 'listed number: code sent on WhatsApp');
ok(wa && wa.url === 'https://graph.facebook.com/v24.0/1122/messages' && wa.init.headers.Authorization === 'Bearer tok', 'sent from Muto\'s WhatsApp number with the token');
const m = wa && JSON.parse(wa.init.body);
ok(m && m.to === LISTED && m.template.name === 'mutos_login' && m.template.language.code === 'en' && m.template.components[0].parameters[0].text === '123456' && m.template.components[1].sub_type === 'url' && m.template.components[1].parameters[0].text === '123456', 'message uses the Authentication template with the code in body and Copy code button');
const dbCall = calls.find(c => c.url.startsWith('https://db.example'));
ok(dbCall && dbCall.init.headers.apikey === 'sb_secret_x' && /active=eq\.true/.test(dbCall.url), 'checks the number against active weddings');

r = await run(req(payload('+919999999999')));
ok(r.status === 403 && /not on Muto's list/.test(r.j.error.message) && !calls.some(c => c.url.includes('graph.facebook.com')), 'number not on any list: refused, nothing sent');
r = await run(req(payload('+' + LISTED), { raw: crypto.randomBytes(32) }));
ok(r.status === 401 && !calls.length, 'wrong signature: refused before anything is checked');
r = await run(req(payload('+' + LISTED), { tamper: true }));
ok(r.status === 401 && !calls.length, 'changed body: refused');
r = await run(req(payload('+' + LISTED), { ts: Math.floor(Date.now() / 1000) - 900 }));
ok(r.status === 401, 'old (replayed) request: refused');
r = await run(new Request('https://mutos-app.example/api/sms-hook', { method: 'POST', body: JSON.stringify(payload('+' + LISTED)) }));
ok(r.status === 401, 'no signature: refused');
r = await run(req({ user: { phone: '+12' }, sms: { otp: '123456' } }));
ok(r.status === 400, 'bad number: refused');
r = await run(req(payload('+' + LISTED)), Object.assign({}, env, { WA_TOKEN: '' }));
ok(r.status === 503 && /Gmail/.test(r.j.error.message), 'WhatsApp not set up: clear message, suggests Gmail');
env.__waDown = true; r = await run(req(payload('+' + LISTED))); env.__waDown = false;
ok(r.status === 502 && r.j.error.http_code === 502, 'WhatsApp down: error goes back to the sign-in page');
r = await run(new Request('https://mutos-app.example/api/otp-status'));
ok(r.status === 200 && r.j.ready === true, 'status says phone sign-in is ready');
r = await run(new Request('https://mutos-app.example/api/otp-status'), Object.assign({}, env, { SMS_HOOK_SECRET: '' }));
ok(r.j.ready === false, 'and not ready while a secret is missing');
ok(await verifyHook(SECRET, new Headers({ 'webhook-id': 'a', 'webhook-timestamp': '100', 'webhook-signature': sign('a', '100', 'x') }), 'x', 100e3), 'signature check matches Standard Webhooks');
ok(JSON.stringify(waMessage('91', '1', {})).includes('"mutos_login"'), 'template name has a default');

console.log(failed ? failed + ' FAILED' : 'ALL PASSED'); process.exit(failed ? 1 : 0);
