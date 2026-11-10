// Supervisor login, end to end (public/supervisor.js, home.js, clients.js, client.html, desk.html, the board's save guard).
// Fake Supabase in the test runner with the rules of supabase/012_supervisor.sql (the real rules: tests/rls_supervisor.sql).
// Run: node tests/supervisor.test.js <backup.json>
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', 'public'), SHOTS = process.env.SHOTS || '';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const OWNER = 'owner.test@gmail.com', SUP = 'supervisor.test@gmail.com', FAM = 'family.test@gmail.com';
const FIELDS = ['name', 'date', 'slot', 'callTime', 'location', 'mapLink', 'contactName', 'contactPhone', 'notes', 'noteSent'];
const pad = n => String(n).padStart(2, '0'), dstr = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const today = dstr(new Date()), inDays = n => dstr(new Date(Date.now() + n * 864e5));

// ── tables ──
const T = {}; ['docs', 'members', 'crew_feed', 'gear_feed', 'client_links', 'client_feed', 'client_itinerary', 'bookings', 'booking_payments', 'packages', 'people', 'work_jobs', 'work_reports', 'drives', 'drive_items', 'drive_moves', 'drive_log'].forEach(t => { T[t] = new Map(); });
const KEY = { docs: r => r.collection + '/' + r.id, members: r => r.email, crew_feed: r => r.person_key, gear_feed: r => r.id, client_links: r => r.wedding_key, client_feed: r => r.wedding_key, client_itinerary: r => r.wedding_key, bookings: r => r.wedding_key };
const keyOf = (t, r) => (KEY[t] || (r => r.id))(r);
const bk = JSON.parse(fs.readFileSync(process.argv[2]));
// make sure there is an upcoming shoot with crew and gear, and a wedding with a phone
const evs = bk.events.map(e => Object.assign({}, e));
const withCrew = evs.find(e => e.date >= today && e.assignments.some(a => a.memberId && a.gearIds.length)) || evs.find(e => e.assignments.some(a => a.memberId));
withCrew.date = withCrew.date >= today ? withCrew.date : inDays(5); withCrew.wedding = 'Sharma'; withCrew.contactPhone = '9876512345';
delete withCrew.status; delete withCrew.eventType; withCrew.legacyField = 'kept'; // stored in an older layout, as some real shoots are
const add = (c, list) => list.forEach(r => T.docs.set(c + '/' + r.id, { collection: c, id: r.id, data: r, created_by: OWNER, created_at: new Date(Date.now() - 864e5).toISOString() }));
add('events', evs); add('shooters', bk.shooters); add('assistants', bk.assistants || []); add('gear', bk.equipment); add('away', bk.unavailability || []);
[[OWNER, 'owner'], [SUP, 'supervisor']].forEach(([email, role]) => T.members.set(email, { email, role, person_key: null, display_name: role }));
T.bookings.set('w:sharma', { wedding_key: 'w:sharma', title: 'Sharma', total: 200000, plan: [], items: [] });
T.packages.set('p1', { id: 'p1', name: 'Premium', price: 200000, items: [] });
T.people.set('pe1', { id: 'pe1', code: 'M001', name: 'Editor One', email: 'ed@x.com', active: true, skills: [], crew_keys: [] });

const role = e => (T.members.get(e) || {}).role || null;
const staff = e => ['owner', 'manager'].includes(role(e)), sup = e => role(e) === 'supervisor', desk = e => staff(e) || sup(e);
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);
const strip = o => { const c = Object.assign({}, o); FIELDS.forEach(f => delete c[f]); return stable(c); };
const hasCrew = d => (d.assignments || []).some(a => a.memberId || (a.gearIds || []).length) || (d.equipmentIds || []).length || (d.assistantIds || []).length;
function canSee(t, r, e) {
  if (!e) return false;
  if (t === 'members') return r.email === e || role(e) === 'owner';
  if (['bookings', 'booking_payments', 'packages'].includes(t)) return staff(e);
  return desk(e);
}
// same rules as 012_supervisor.sql (plus schema.sql for the owner)
function writeErr(t, r, old, e, op) {
  if (!e) return 'not signed in';
  if (staff(e)) return null;
  if (!sup(e)) return 'new row violates row-level security policy';
  if (t === 'docs') {
    if (op === 'delete') return r.collection === 'events' && r.created_by === e && Date.now() - Date.parse(r.created_at) < 3600e3 ? null : 'quiet';
    if (!['events', 'history'].includes(r.collection)) return 'new row violates row-level security policy for table "docs"';
    if (r.collection === 'events') {
      if (old) { if (strip(old.data) !== strip(r.data)) return 'A supervisor can change only the itinerary and the client\'s contact'; }
      else if (hasCrew(r.data)) return 'A supervisor adds shoots without crew or gear';
    }
    return null;
  }
  if (['crew_feed', 'gear_feed', 'client_links', 'client_feed', 'client_itinerary', 'work_jobs'].includes(t)) return op === 'delete' ? 'quiet' : null;
  return 'new row violates row-level security policy for table "' + t + '"';
}
const match = (r, f) => f.every(([op, c, v]) => op === 'is' ? (r[c] ?? null) === v : op === 'eq' ? r[c] === v : op === 'gte' ? String(r[c] ?? '') >= v : op === 'lte' ? String(r[c] ?? '') <= v : v.includes(r[c]));
let me = SUP, rtFire = null;
const rpcLog = [];
function rpc(fn, a, e) {
  rpcLog.push(fn);
  if (fn === 'client_list') return { data: [...T.client_links.values()].filter(l => l.active && (l.emails || []).includes(e)).map(l => ({ token: l.token, title: l.title })), error: null };
  if (fn === 'client_get' || fn === 'client_save') {
    const l = [...T.client_links.values()].find(x => x.token === a.p_token && x.active);
    if (!l) return { data: { error: 'This page is not active.' }, error: null };
    const fam = (l.emails || []).includes(e);
    if (!fam && !desk(e)) return { data: { error: 'not on the list', not_listed: true }, error: null };
    const i = T.client_itinerary.get(l.wedding_key) || {};
    if (fn === 'client_get') { const f = T.client_feed.get(l.wedding_key); return { data: { title: l.title, functions: (f && f.data.functions) || [], answers: i.data || {}, submitted_at: i.submitted_at || null, preview: !fam, studio_edit: !fam, updated_by: i.updated_by || null, booking: fam || staff(e) ? { total: 200000, paid: 0, pending: 200000 } : null }, error: null }; }
    T.client_itinerary.set(l.wedding_key, Object.assign({ wedding_key: l.wedding_key }, i, { data: a.p_data, updated_at: new Date().toISOString(), updated_by: e, submitted_at: a.p_submit && fam ? new Date().toISOString() : i.submitted_at || null }));
    return { data: { ok: true }, error: null };
  }
  if (fn === 'sup_save_event') { // same as 012: an existing shoot takes only his fields; a new one goes in as sent (no crew)
    if (!sup(e)) return { data: { error: 'Only for the supervisor login.' }, error: null };
    const k = 'events/' + a.p_id, old = T.docs.get(k);
    if (old) { const data = Object.assign({}, old.data); FIELDS.forEach(f => { if (f in a.p_data) data[f] = a.p_data[f]; else delete data[f]; }); const r = Object.assign({}, old, { data }); T.docs.set(k, r); if (rtFire) setTimeout(() => rtFire({ eventType: 'UPDATE', new: r, old: {} }), 300); }
    else { if (hasCrew(a.p_data)) return { data: null, error: { message: 'A supervisor adds shoots without crew or gear' } }; const r = { collection: 'events', id: a.p_id, data: a.p_data, created_by: e, created_at: new Date().toISOString() }; T.docs.set(k, r); if (rtFire) setTimeout(() => rtFire({ eventType: 'INSERT', new: r, old: {} }), 300); }
    return { data: { ok: true }, error: null };
  }
  if (fn === 'people_directory') return { data: desk(e) ? [...T.people.values()].map(p => ({ id: p.id, code: p.code, name: p.name, keeper: false })) : [], error: null };
  return { data: null, error: { message: 'no rpc ' + fn } };
}
function handle(d) {
  const e = me;
  if (d.op === 'session') return e ? { id: 'u-' + e, email: e, user_metadata: { full_name: e.split('.')[0] } } : null;
  if (d.op === 'signin' || d.op === 'signout') return null;
  if (d.op === 'rpc') return rpc(d.fn, d.args, e);
  const t = T[d.table]; if (!t) return { data: d.single ? null : [], error: null };
  if (d.op === 'select') {
    let rows = [...t.values()].filter(r => canSee(d.table, r, e) && match(r, d.filters));
    if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1);
    return { data: d.single ? rows[0] || null : JSON.parse(JSON.stringify(rows)), error: null };
  }
  if (d.op === 'delete') {
    [...t.entries()].forEach(([k, r]) => { if (match(r, d.filters) && canSee(d.table, r, e) && !writeErr(d.table, r, r, e, 'delete')) { t.delete(k); if (d.table === 'docs' && rtFire) setTimeout(() => rtFire({ eventType: 'DELETE', old: { collection: r.collection, id: r.id }, new: {} }), 200); } });
    return { data: null, error: null };
  }
  if (d.op === 'update') {
    for (const [k, r] of t.entries()) if (match(r, d.filters) && canSee(d.table, r, e)) { const n = Object.assign({}, r, d.rows[0]); const er = writeErr(d.table, n, r, e, 'update'); if (er) return er === 'quiet' ? { data: null, error: null } : { data: null, error: { message: er } }; t.set(k, n); }
    return { data: null, error: null };
  }
  // insert / upsert
  for (const row of d.rows) {
    const r = Object.assign({}, row), k = keyOf(d.table, r), old = t.get(k);
    if (d.op === 'insert' && old) return { data: null, error: { message: 'duplicate key' } };
    const er = writeErr(d.table, r, old, e, old ? 'update' : 'insert'); if (er) return { data: null, error: { message: er } };
    if (d.table === 'docs') { r.created_by = old ? old.created_by : e; r.created_at = old ? old.created_at : new Date().toISOString(); if (rtFire) setTimeout(() => rtFire({ eventType: old ? 'UPDATE' : 'INSERT', new: r, old: {} }), 300); }
    if (d.table === 'client_links' && !r.token) r.token = crypto.randomUUID();
    if (d.table === 'client_links' && r.active === undefined) r.active = true;
    t.set(k, Object.assign({}, old || {}, r));
  }
  return { data: null, error: null };
}

const srv = http.createServer((q, s) => { let p = q.url.split('?')[0]; if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(s); });
(async () => {
  await new Promise(r => srv.listen(8821, r));
  const B = 'http://localhost:8821';
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr\.net\/npm\/@supabase/, r => r.abort());
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d));
  await ctx.exposeBinding('__rtReady', () => {});
  await ctx.addInitScript(fs.readFileSync(path.join(__dirname, 'mock-supabase.js'), 'utf8'));
  await ctx.addInitScript(() => { const t = setInterval(() => { if (window.__rtFire) { clearInterval(t); window.__mockRt = window.__rtFire; } }, 20); });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', x => errs.push(String(x)));
  if (process.env.DEBUG) { p.on('console', m => console.log('console:', m.text().slice(0, 200))); p.on('pageerror', x => console.log('err:', String(x).slice(0, 300))); }
  rtFire = payload => p.evaluate(pl => window.__rtFire && window.__rtFire(pl), payload).catch(() => {});
  const docOf = id => (T.docs.get('events/' + id) || {}).data;
  const toast = () => p.textContent('#sb-toast').catch(() => '');

  // ── Home ──
  await p.goto(B + '/board.html'); await p.waitForFunction(() => window.__boardApi && document.querySelector('#mh-desks'), null, { timeout: 20000 });
  const desks = await p.$$eval('#mh-desks [data-desk]', x => x.map(b => b.dataset.desk));
  ok(JSON.stringify(desks) === '["shoots","work","clients"]', 'supervisor Home: Shoots, Work and Clients desks only (' + desks + ')');
  ok(!(await p.$('#mutos-updates')) && !(await p.$('#mutos-bar a[href="/gear.html"]')), 'no Team updates or Gear desk in the header');
  await p.click('[data-desk="shoots"]'); await p.waitForSelector('#mh-tiles');
  const tiles = await p.$$eval('#mh-tiles [data-tile], #mh-tiles a', x => x.map(b => b.dataset.tile || b.getAttribute('href')));
  ok(JSON.stringify(tiles) === '["board","sb-new-wedding","sb-callsheet","sb-history"]', 'Shoots desk: board, new wedding, call sheet, history (' + tiles + ')');
  await p.keyboard.press('Escape');
  await p.click('#mutos-settings'); await p.waitForSelector('#mh-more');
  ok(JSON.stringify(await p.$$eval('#mh-more [data-act]', x => x.map(b => b.dataset.act))) === '["out"]', 'Settings holds only Sign out (no backups, logins or export)');
  await p.keyboard.press('Escape');
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'supervisor-home.png') });

  // ── the board ──
  await p.evaluate(() => { location.hash = 'board'; }); await sleep(400);
  await p.evaluate(d => window.__boardApi.goToDate(d), withCrew.date); await sleep(400);
  const vis = await p.evaluate(id => { const card = document.getElementById('card-' + id); const v = s => [...card.querySelectorAll(s)].filter(x => x.offsetParent).length; return { edit: v('[data-action="edit"]'), crew: v('[data-action="crew"], [data-action="removeperson"], [data-action="persongear"], [data-action="gengear"]') }; }, withCrew.id);
  ok(vis.edit > 0 && vis.crew === 0, 'shoot card: Edit shows, crew and gear buttons do not');
  ok(await p.evaluate(() => ['sb-manage-shooters', 'sb-manage-gear', 'sb-billing', 'sb-restore'].every(id => { const el = document.getElementById(id); return !el || !el.offsetParent; })), 'crew list, gear list, billing and load backup are hidden');
  // edit window: itinerary yes, crew-side fields no
  await p.evaluate(id => document.querySelector('#card-' + id + ' [data-action="edit"]').click(), withCrew.id); await p.waitForSelector('#ef-loc');
  const form = await p.evaluate(() => ({ cov: document.querySelector('#ef-coverage').disabled, wed: document.querySelector('#ef-wedding').disabled, tier: document.querySelector('#ef-tier').disabled, loc: document.querySelector('#ef-loc').disabled, cancel: document.querySelector('#ef-cancel').hidden, del: document.querySelector('#ef-delete').hidden, note: !!document.querySelector('#ef-limits') }));
  ok(form.cov && form.wed && form.tier && !form.loc && form.cancel && form.del && form.note, 'edit window: venue editable; coverage, wedding, tier locked; no Cancel or Delete');
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'supervisor-edit.png') });
  const crewBefore = JSON.stringify(docOf(withCrew.id).assignments);
  await p.fill('#ef-loc', 'Clarks Avadh, Lucknow'); await p.fill('#ef-cphone', '9000011111'); await p.fill('#ef-call', '16:30');
  await p.click('#ef-save'); await sleep(1500);
  const d1 = docOf(withCrew.id);
  const crewOf = a => JSON.stringify((a || []).map(x => [x.memberId, x.gearIds]));
  ok(d1.location === 'Clarks Avadh, Lucknow' && d1.contactPhone === '9000011111' && d1.callTime === '16:30' && crewOf(d1.assignments) === crewOf(JSON.parse(crewBefore)), 'saves venue, client phone and report time; crew untouched ' + JSON.stringify([d1.location, d1.contactPhone, d1.callTime]));
  ok(d1.legacyField === 'kept' && !('status' in d1), 'an older-layout shoot keeps everything else exactly as stored');
  // anything else is put back before it is sent
  await p.evaluate(id => { const ev = window.__boardApi.state().events.find(e => e.id === id); ev.assignments = []; ev.coverage = '9+9'; window.__boardApi.save(); }, withCrew.id); await sleep(1500);
  const back1 = await p.evaluate(id => window.__boardApi.state().events.find(e => e.id === id), withCrew.id);
  ok(JSON.stringify(docOf(withCrew.id).assignments) === crewBefore && docOf(withCrew.id).coverage !== '9+9', 'removing crew or changing coverage never reaches the database');
  ok(JSON.stringify(back1.assignments) === crewBefore && back1.coverage === docOf(withCrew.id).coverage, '… and is put back on his screen');
  ok(/put back/.test(await toast()), 'he is told why: ' + (await toast()).slice(0, 90));
  await p.evaluate(id => { const st = window.__boardApi.state(); st.events = st.events.filter(e => e.id !== id); window.__boardApi.save(); }, withCrew.id); await sleep(1500);
  ok(!!docOf(withCrew.id) && await p.evaluate(id => !!window.__boardApi.state().events.find(e => e.id === id), withCrew.id), 'deleting an older shoot is put back');
  const sh = bk.shooters[0];
  await p.evaluate(id => { const s = window.__boardApi.state().shooters.find(x => x.id === id); s.rateShort = 99999; window.__boardApi.save(); }, sh.id); await sleep(1500);
  ok(T.docs.get('shooters/' + sh.id).data.rateShort !== 99999, 'changing a shooter\'s rate is put back');
  // a new shoot: allowed, and his own can be deleted within the hour
  const nid = await p.evaluate(d => { const a = window.__boardApi; const ev = { id: 'sup-new-1', name: 'Sharma Haldi', wedding: 'Sharma', date: d, slot: 'Morning', coverage: '2+2', location: 'Lucknow', assignments: [], equipmentIds: [], assistantIds: [], tier: 'Standard', status: 'confirmed', eventType: 'short', callTime: '', contactName: '', contactPhone: '', mapLink: '', notes: '' }; a.state().events.push(ev); a.save(); return ev.id; }, inDays(9));
  await sleep(1500);
  ok(docOf(nid) && T.docs.get('events/' + nid).created_by === SUP, 'adds a new shoot (without crew)');
  await p.evaluate(d => window.__boardApi.goToDate(d), inDays(9)); await sleep(400);
  await p.evaluate(id => document.querySelector('#card-' + id + ' [data-action="edit"]').click(), nid); await p.waitForSelector('#ef-delete');
  ok(!(await p.$eval('#ef-delete', x => x.hidden)), 'his own new shoot shows Delete');
  await p.click('#ef-delete'); await p.click('#ef-delete'); await sleep(1500);
  ok(!docOf(nid), 'he deletes his own new shoot (a mistake)');
  ok(errs.length === 0, 'no page errors on the board ' + errs.slice(0, 2).join(' | '));

  // ── clients, without money ──
  await p.evaluate(() => window.MUTOS_CLIENTS.open()); await p.waitForSelector('.sb-modal');
  ok(!(await p.$('#cl-packages')) && !(await p.$('[data-book]')) && !/overdue|to come|Paid in full/.test(await p.textContent('.sb-modal')), 'Clients window: no packages, payments or money');
  const make = await p.$('.sb-modal [data-make]'); ok(!!make, 'can add a family Gmail');
  await make.click(); await p.waitForSelector('#cg-mails'); await p.fill('#cg-mails', FAM); await p.click('#cg-save'); await sleep(1200);
  const link = [...T.client_links.values()][0];
  ok(link && link.emails.includes(FAM), 'family Gmail saved by the supervisor');
  ok(await p.$('.sb-modal a[href*="client.html?k="]') && /Open & edit/.test(await p.textContent('.sb-modal')), '"Open & edit" the family\'s page');
  // the family's form, edited for them
  await p.goto(B + '/client.html?k=' + link.token); await p.waitForSelector('.fn');
  ok(await p.isVisible('#studio-note') && await p.isHidden('#send') && await p.isVisible('#save') && !(await p.$eval('.fn input', x => x.disabled)), 'family page opens for editing, Send hidden (only the family sends)');
  ok(!/₹/.test(await p.innerText('body')), 'no money on the family page for him');
  await p.fill('.fn input[data-f="time"]', '18:30'); await p.click('#save'); await sleep(1200);
  const it = T.client_itinerary.get(link.wedding_key);
  ok(it && it.updated_by === SUP && !it.submitted_at, 'saved with his name, not counted as sent by the family');
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'supervisor-client.png') });

  // ── work desk ──
  await p.goto(B + '/desk.html'); await p.waitForSelector('.bnav .tab');
  const tabs = await p.$$eval('.bnav .tab', x => x.map(b => b.dataset.tab));
  ok(!tabs.includes('people') && tabs.includes('jobs') && tabs.includes('drives'), 'Work desk: jobs, reports, month, drives; no People register (' + tabs + ')');
  await p.goto(B + '/desk.html?tab=people'); await p.waitForSelector('.bnav .tab.on');
  ok(await p.$eval('.bnav .tab.on', x => x.dataset.tab) === 'jobs', 'asking for People opens Jobs instead');

  // ── the owner is unchanged ──
  me = OWNER;
  const o = await ctx.newPage(); o.on('pageerror', x => errs.push(String(x)));
  await o.goto(B + '/board.html'); await o.waitForFunction(() => window.__boardApi && document.querySelector('#mh-desks'), null, { timeout: 20000 });
  ok((await o.$$eval('#mh-desks [data-desk]', x => x.length)) === 6 && !!(await o.$('#mutos-updates')), 'owner Home: all six desks and Team updates');
  await o.evaluate(() => { location.hash = 'board'; }); await sleep(300); await o.evaluate(d => window.__boardApi.goToDate(d), withCrew.date); await sleep(300);
  await o.evaluate(id => document.querySelector('#card-' + id + ' [data-action="edit"]').click(), withCrew.id); await o.waitForSelector('#ef-delete');
  ok(!(await o.$eval('#ef-coverage', x => x.disabled)) && !(await o.$eval('#ef-delete', x => x.hidden)) && !(await o.$('#ef-limits')), 'owner edit window: everything editable, Delete there');
  await o.keyboard.press('Escape');
  await o.evaluate(() => window.MUTOS_APP.openLogins()); await o.waitForSelector('#lg-sadd');
  await o.fill('#lg-sname', 'Supervisor Two'); await o.fill('#lg-semail', 'sup.two@gmail.com'); await o.click('#lg-sadd'); await sleep(800);
  ok(role('sup.two@gmail.com') === 'supervisor', 'Team logins: the owner adds a supervisor');
  ok(errs.length === 0, 'no page errors ' + errs.slice(0, 2).join(' | '));
  await b.close(); srv.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
