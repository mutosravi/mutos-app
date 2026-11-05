// End-to-end test of the new Muto's app parts: client itinerary links and attendance & salary.
// Fake Supabase in the test runner with simplified copies of supabase/004_studio.sql's rules (the real rules are tested in tests/rls_studio.sql).
// Run: node tests/studio.test.js <dir with events/, shooters/, gear/ JSON exports>
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', 'public'), DATA = process.argv[2], SHOTS = process.env.SHOTS || '.';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const OWNER = 'owner.test@gmail.com', STAFF = 'office.staff@gmail.com', ACC = 'accounts@gmail.com', KIOSK = 'office.screen@gmail.com', CREWE = 'crew.emp@gmail.com';
const OFFICE = { latitude: 26.8467, longitude: 80.9462 }, FAR = { latitude: 26.90, longitude: 81.00 }, CODE = '482913';
const pad = n => String(n).padStart(2, '0');
const istDay = (o = 0) => new Date(Date.now() + 330 * 60000 + o * 864e5).toISOString().slice(0, 10);
const T = {}; ['docs', 'members', 'crew_feed', 'crew_away', 'crew_status', 'gear_feed', 'gear_log', 'push_subs', 'client_links', 'client_feed', 'client_itinerary', 'employees', 'att_settings', 'att_punch', 'att_requests', 'holidays', 'payroll_runs', 'payslips', 'att_log', 'people', 'people_private', 'work_jobs', 'work_reports'].forEach(t => { T[t] = new Map(); });
const KEY = { docs: r => r.collection + '/' + r.id, members: r => r.email, crew_feed: r => r.person_key, client_links: r => r.wedding_key, client_feed: r => r.wedding_key, client_itinerary: r => r.wedding_key, employees: r => r.email, att_settings: r => String(r.id), payroll_runs: r => r.month, payslips: r => r.month + '|' + r.email, crew_status: r => r.person_key + '|' + r.event_id, people_private: r => r.person };
const keyOf = (t, r) => (KEY[t] || (r => r.id))(r);
let seq = 1; const newId = () => 'id' + (seq++);
T.att_settings.set('1', { id: 1, office_lat: null, office_lng: null, radius_m: 150, code_on: true, late_night_min: 120 });
const role = e => (T.members.get(e) || {}).role || null;
const isOwner = e => role(e) === 'owner', staff = e => ['owner', 'manager'].includes(role(e)), payroll = e => ['owner', 'accountant'].includes(role(e));
const pkOf = e => (T.members.get(e) || {}).person_key;
const myPerson = e => { const p = [...T.people.values()].find(x => e && x.email === e && x.active); return p ? p.id : null; };
function canSee(t, r, e) {
  if (!e) return false;
  if (t === 'docs' || t.startsWith('client_') || t === 'gear_feed') return staff(e) || (t === 'gear_feed' && role(e) === 'gear');
  if (t === 'members') return r.email === e || isOwner(e);
  if (t === 'crew_feed') return staff(e) || role(e) === 'accountant' || r.person_key === pkOf(e);
  if (['employees', 'att_punch', 'att_requests', 'payslips'].includes(t)) return r.email === e || payroll(e);
  if (t === 'payroll_runs' || t === 'att_log') return payroll(e);
  if (t === 'att_settings' || t === 'holidays') return true;
  // same rules as 007_work_desk.sql
  if (t === 'people') return staff(e) || payroll(e) || r.id === myPerson(e);
  if (t === 'people_private') return payroll(e) || r.person === myPerson(e);
  if (t === 'work_jobs') return staff(e) || (r.assignee && r.assignee === myPerson(e));
  if (t === 'work_reports') return staff(e) || r.person === myPerson(e);
  return staff(e);
}
function canWrite(t, r, e) {
  if (!e) return false;
  if (t === 'members') return isOwner(e) && r.role !== 'owner';
  if (t === 'docs' || t === 'crew_feed' || t === 'client_links' || t === 'client_feed' || t === 'client_itinerary') return staff(e);
  if (['employees', 'att_settings', 'holidays', 'payslips', 'att_punch'].includes(t)) return isOwner(e);
  if (t === 'payroll_runs') return payroll(e);
  if (t === 'att_requests') return true;
  if (t === 'people') return staff(e);
  if (t === 'people_private') return isOwner(e) || r.person === myPerson(e);
  if (t === 'work_jobs' || t === 'work_reports') return staff(e) || (t === 'work_jobs' ? r.assignee && r.assignee === myPerson(e) : r.person === myPerson(e));
  return staff(e);
}
const match = (r, f) => f.every(([op, c, v]) => op === 'eq' ? r[c] === v : op === 'gte' ? String(r[c] ?? '') >= v : op === 'lte' ? String(r[c] ?? '') <= v : v.includes(r[c]));
const err = m => ({ data: null, error: { message: m } });
// same rules as the triggers in 004_studio.sql
function before(t, r, old, e) {
  if (t === 'att_requests' && !old && !isOwner(e)) {
    r.email = e; r.status = 'pending'; r.recovered = 0; r.id = r.id || newId(); r.created_at = new Date().toISOString();
    const emp = T.employees.get(e); if (!emp || !emp.active) return 'You are not on the employee list.';
    if (r.kind === 'advance') { const open = [...T.att_requests.values()].filter(x => x.email === e && x.kind === 'advance' && x.status !== 'declined').reduce((s, x) => s + x.amount - x.recovered, 0); if (open + r.amount > emp.monthly_salary) return 'Advances can be up to one month\'s salary.'; }
  }
  if (t === 'att_requests' && old) {
    if (!isOwner(e)) return 'Only the owner can decide requests.';
    if (r.kind === 'fix' && r.status === 'approved' && old.status !== 'approved') T.att_punch.set('p' + seq, { id: 'p' + (seq++), email: r.email, day: r.day, kind: r.fix_kind, at: new Date(r.day + 'T' + r.fix_time + ':00+05:30').toISOString(), by_fix: true });
  }
  if (t === 'payroll_runs') { if (old && old.status === 'locked') return 'This month is locked.'; if (r.status === 'locked' && !isOwner(e)) return 'Only the owner can lock a month.'; if (r.status === 'locked') r.locked_at = new Date().toISOString(); }
  if (t === 'att_settings' && old && old.code_on !== r.code_on) T.att_log.set(newId(), { id: newId(), at: new Date().toISOString(), by_email: e, what: 'Office code check turned ' + (r.code_on ? 'ON' : 'OFF') });
  if (t === 'holidays') { r.id = r.id || newId(); r.ask_in = r.ask_in || []; }
  if (t === 'people') {
    if (!old && !r.code) r.code = 'M' + String(Math.max(0, ...[...T.people.values()].map(x => Number(x.code.slice(1)))) + 1).padStart(3, '0');
    if (old && r.code !== old.code) return 'The employee code cannot change.';
    if (r.email && (r.email !== r.email.toLowerCase() || [...T.people.values()].some(x => x.email === r.email && x.id !== r.id))) return 'duplicate or bad email';
    r.id = r.id || crypto.randomUUID(); r.name = String(r.name).trim(); r.active = r.active !== false; r.skills = r.skills || []; r.crew_keys = r.crew_keys || [];
  }
  if (t === 'people_private' && r.id_last4 && !/^[0-9A-Za-z]{4}$/.test(r.id_last4)) return 'check constraint id_last4';
  if (t === 'work_jobs') {
    const now = new Date().toISOString();
    if (!old) Object.assign(r, Object.assign({ id: r.id || crypto.randomUUID(), status: 'todo', progress: 0, count_done: 0, count_total: null, round: 1, event_ids: [], created_by: e, created_at: now }, r));
    if (old && !staff(e)) {
      for (const k of ['wedding_key', 'wedding_title', 'wedding_date', 'fn_label', 'kind', 'title', 'assignee', 'due', 'round', 'count_total', 'created_by']) if ((r[k] ?? null) !== (old[k] ?? null)) return 'Only the studio can change who does a job, its due date or what it is.';
      if (r.status !== old.status && !(['editing', 'rendered'].includes(r.status) && ['todo', 'editing', 'rendered', 'changes'].includes(old.status))) return 'You can mark a job as Editing or Rendered.';
    } else if (old && r.status === 'changes' && old.status !== 'changes' && r.round === old.round) r.round = old.round + 1;
    if (r.status === 'rendered' && !['top', 'lr', 'album_sel'].includes(r.kind)) r.progress = 100;
    if (['editing', 'rendered'].includes(r.status) && !r.started_at) r.started_at = now;
    if (r.status === 'final' && (!old || old.status !== 'final')) r.done_at = now;
    if (r.status !== 'final') r.done_at = null;
  }
  if (t === 'work_reports') {
    if (old) return 'permission denied for table work_reports';
    r.id = r.id || crypto.randomUUID(); r.day = r.day || istDay(); r.by_email = e; r.at = new Date().toISOString();
    if (!staff(e)) {
      if (r.person !== myPerson(e)) return 'You can only write your own report.';
      if (r.day < istDay(-1) || r.day > istDay()) return 'Reports are for today (or yesterday, if you forgot).';
      if (r.job && !((T.work_jobs.get(r.job) || {}).assignee === r.person)) return 'That job is not yours.';
    }
    if (!r.job && !String(r.note || '').trim()) return 'Write what you worked on.';
  }
  return null;
}
function rpc(fn, a, e) {
  // same rules as 005_client_login.sql
  if (fn.startsWith('client_') && !e) return { data: null, error: { message: 'permission denied for function ' + fn, code: '42501' } };
  if (fn === 'client_list') return { data: [...T.client_links.values()].filter(l => l.active && l.emails.includes(e)).map(l => ({ token: l.token, title: l.title })), error: null };
  if (fn === 'client_get' || fn === 'client_save') {
    const l = [...T.client_links.values()].find(x => x.token === a.p_token && x.active);
    if (!l) return { data: { error: 'This page is not active.' }, error: null };
    const listed = l.emails.includes(e);
    if (fn === 'client_get') { if (!listed && !staff(e)) return { data: { error: 'This Gmail (' + e + ') is not on Muto\'s list for this wedding.', not_listed: true }, error: null }; const f = T.client_feed.get(l.wedding_key), i = T.client_itinerary.get(l.wedding_key) || {}; return { data: { title: l.title, functions: (f && f.data.functions) || [], answers: i.data || {}, submitted_at: i.submitted_at || null, preview: !listed }, error: null }; }
    if (!listed) return { data: { error: 'Only the family\'s registered Gmail can fill this in.' }, error: null };
    const cur = T.client_itinerary.get(l.wedding_key) || { wedding_key: l.wedding_key };
    T.client_itinerary.set(l.wedding_key, Object.assign(cur, { data: a.p_data, updated_at: new Date().toISOString(), submitted_at: a.p_submit ? new Date().toISOString() : cur.submitted_at || null }));
    return { data: { ok: true }, error: null };
  }
  if (fn === 'att_office_code') return ['owner', 'kiosk'].includes(role(e)) ? { data: { code: CODE, seconds_left: 25 }, error: null } : err('Only the office screen can show the code.');
  if (fn === 'att_punch') {
    const emp = T.employees.get(e); if (!emp || !emp.active) return { data: { error: 'You are not on the employee list. Ask Ravi.' }, error: null };
    const st = T.att_settings.get('1'); if (st.office_lat == null) return { data: { error: 'The office location is not set yet.' }, error: null };
    const R = 6371000, rad = x => x * Math.PI / 180, dl = rad(a.p_lat - st.office_lat), dg = rad(a.p_lng - st.office_lng);
    const dist = 2 * R * Math.asin(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(rad(st.office_lat)) * Math.cos(rad(a.p_lat)) * Math.sin(dg / 2) ** 2));
    if (dist - Math.min(a.p_acc || 0, 50) > st.radius_m) return { data: { error: 'You are not at the office (' + Math.round(dist) + ' m away).' }, error: null };
    if (st.code_on && a.p_code !== CODE) return { data: { error: 'Wrong or old office code.' }, error: null };
    const d = istDay(), mine = [...T.att_punch.values()].filter(p => p.email === e && p.day === d).sort((x, y) => x.at.localeCompare(y.at)), last = mine.length ? mine[mine.length - 1].kind : '';
    const next = { '': ['in'], in: ['lunch_out', 'out'], lunch_out: ['lunch_in'], lunch_in: ['out'], out: [] }[last];
    if (!next.includes(a.p_kind)) return { data: { error: 'That step is not next.' }, error: null };
    const h = [...T.holidays.values()].find(x => x.day === d && (!x.only_for || x.only_for.includes(e)));
    const row = { id: newId(), email: e, day: d, kind: a.p_kind, at: new Date().toISOString(), dist_m: Math.round(dist), via_code: st.code_on, flag: h && !h.ask_in.includes(e) ? 'holiday_unasked' : null };
    T.att_punch.set(row.id, row); return { data: { ok: true, kind: a.p_kind, flag: row.flag }, error: null };
  }
  return err('no function ' + fn);
}
function handle(e, d) {
  if (d.op === 'session') return e ? { id: 'u-' + e, email: e, user_metadata: { full_name: e.split('@')[0] } } : null;
  if (d.op === 'signout' || d.op === 'signin') return null;
  if (d.op === 'rpc') return rpc(d.fn, d.args, e);
  const t = T[d.table]; if (!t) return err('no table ' + d.table);
  if (!e) return { data: null, error: { message: 'permission denied', code: '42501' } };
  if (d.op === 'select') {
    let rows = [...t.values()].filter(r => canSee(d.table, r, e) && match(r, d.filters));
    d.order.forEach(([c, asc]) => rows.sort((a, b) => String(a[c] ?? '').localeCompare(String(b[c] ?? '')) * (asc ? 1 : -1)));
    if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1); if (d.limit) rows = rows.slice(0, d.limit);
    rows = JSON.parse(JSON.stringify(rows)); return { data: d.single ? (rows[0] || null) : rows, error: null };
  }
  if (d.op === 'update') {
    const rows = [...t.values()].filter(r => match(r, d.filters) && canSee(d.table, r, e) && canWrite(d.table, r, e));
    for (const r of rows) { const nr = Object.assign({}, r, d.rows[0]); const m = before(d.table, nr, r, e); if (m) return err(m); Object.assign(r, nr); }
    return { data: null, error: null };
  }
  if (d.op === 'insert' || d.op === 'upsert') {
    for (const r of d.rows) {
      if (d.table === 'client_links') { r.token = r.token || crypto.randomUUID(); r.active = r.active !== false; r.emails = (r.emails || []).map(x => x.trim().toLowerCase()); if (d.op === 'insert' && t.has(keyOf(d.table, r))) return err('duplicate key'); }
      if (d.table === 'att_requests' && !r.id) r.id = newId();
      const old = d.op === 'upsert' ? t.get(keyOf(d.table, r)) : null;
      if (!canWrite(d.table, r, e)) return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } };
      const m = before(d.table, r, old, e); if (m) return err(m);
    }
    d.rows.forEach(r => t.set(keyOf(d.table, r), Object.assign({}, d.op === 'upsert' ? t.get(keyOf(d.table, r)) || {} : {}, r)));
    return { data: null, error: null };
  }
  if (d.op === 'delete') {
    const canDel = r => d.table === 'people' ? isOwner(e) : d.table === 'work_reports' ? (isOwner(e) || (r.person === myPerson(e) && r.day === istDay())) : d.table === 'work_jobs' ? staff(e) : (canWrite(d.table, r, e) || (d.table === 'att_requests' && r.email === e && r.status === 'pending'));
    [...t.values()].filter(r => match(r, d.filters) && canSee(d.table, r, e) && canDel(r)).forEach(r => t.delete(keyOf(d.table, r)));
    return { data: null, error: null };
  }
}
function seed(dir, coll) { const p = path.join(DATA, dir); if (!fs.existsSync(p)) return 0; let n = 0; fs.readdirSync(p).forEach(f => { const data = JSON.parse(fs.readFileSync(path.join(p, f))); const id = data.id || f.replace(/\.json$/, ''); delete data.id; T.docs.set(coll + '/' + id, { collection: coll, id, data }); n++; }); return n; }
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((q, s) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(s); });
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-supabase.js'), 'utf8');

(async () => {
  console.log('seeded', seed('events', 'events') + seed('shooters', 'shooters') + seed('gear', 'gear') + seed('assistants', 'assistants'), 'docs');
  T.members.set(OWNER, { email: OWNER, role: 'owner', display_name: 'Owner' });
  await new Promise(r => server.listen(8799, r));
  const B = 'http://localhost:8799', browser = await chromium.launch(), pages = [];
  async function as(email, opts) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, geolocation: OFFICE, permissions: ['geolocation'] }, opts || {}));
    const box = { email };
    await ctx.exposeBinding('__mockCall', (src, d) => { if (d.op === 'signout') { box.email = null; return null; } return handle(box.email, d); });
    await ctx.addInitScript(MOCK);
    const page = await ctx.newPage(); page.errs = []; page.on('pageerror', x => page.errs.push(String(x))); page.on('dialog', dg => dg.accept(dg.type() === 'prompt' ? (page.nextPrompt || '') : undefined)); pages.push(page);
    return page;
  }

  // ── 1. owner makes a client link from Home → Clients ──
  const owner = await as(OWNER, { viewport: { width: 1280, height: 900 } });
  await owner.goto(B + '/'); await owner.waitForURL('**/board.html'); await owner.waitForSelector('#mh-tiles .tile', { timeout: 20000 });
  ok(await owner.isVisible('[data-tile="clients"]') && await owner.isVisible('#mh-tiles a[href="/attendance.html"]'), 'owner Home has Clients and Attendance tiles');
  ok(!(await owner.textContent('#mutos-bar .logo')).includes('Studio'), 'logo is just "Muto\'s"');
  await owner.click('[data-tile="clients"]'); await owner.waitForSelector('.sb-modal [data-make]');
  const wed = await owner.evaluate(() => window.MUTOS_CLIENTS._weddings()[0]);
  ok(wed && wed.events.length >= 1, 'Clients lists upcoming weddings (first: ' + (wed && wed.title) + ', ' + (wed && wed.events.length) + ' functions)');
  await owner.click('.sb-modal [data-make="' + wed.key + '"]'); await owner.waitForSelector('#cg-mails');
  await owner.fill('#cg-mails', 'not-an-email'); await owner.click('#cg-save'); await owner.waitForTimeout(300);
  ok(!T.client_links.get(wed.key), 'a wrong Gmail is not saved');
  await owner.fill('#cg-mails', 'Akriti.Family@gmail.com, rohan.family@gmail.com'); await owner.click('#cg-save'); await owner.waitForSelector('.sb-modal [data-wa="' + wed.key + '"]');
  const link = T.client_links.get(wed.key), FAM = 'akriti.family@gmail.com';
  ok(link && link.token && link.emails.join() === FAM + ',rohan.family@gmail.com' && T.client_feed.get(wed.key) && T.client_feed.get(wed.key).data.functions.length === wed.events.length, 'client Gmails saved and the family\'s function list shared');
  const waHref = await owner.getAttribute('.sb-modal [data-wa="' + wed.key + '"]', 'href');
  ok(/wa\.me\/\d*\?text=/.test(waHref) && decodeURIComponent(waHref).includes('/client and sign in with ' + FAM + ' or rohan.family@gmail.com') && !decodeURIComponent(waHref).includes(link.token), 'WhatsApp message says where to sign in and with which Gmail (no secret link)');
  await owner.screenshot({ path: path.join(SHOTS, 'clients-window.png') });
  await owner.keyboard.press('Escape');

  // ── 2. the family signs in with their Gmail and fills it in ──
  const visitor = await as(null);
  await visitor.goto(B + '/client.html?k=' + link.token); await visitor.waitForSelector('#gsign');
  ok(!(await visitor.$('.fn')), 'not signed in: only a "Sign in with Google" button, no details');
  ok(handle(null, { op: 'rpc', fn: 'client_get', args: { p_token: link.token } }).error, 'visitors cannot read a wedding even with the secret id');
  const stranger = await as('someone.else@gmail.com');
  await stranger.goto(B + '/client.html?k=' + link.token); await stranger.waitForFunction(() => /Not your wedding/.test(document.body.textContent));
  ok(!(await stranger.$('.fn')), 'another Gmail cannot open the family\'s page');
  await stranger.goto(B + '/client.html'); await stranger.waitForFunction(() => /could not find your wedding/.test(document.body.textContent));
  ok((await stranger.textContent('#top')).includes('someone.else@gmail.com'), 'and is told which Gmail they used');
  const fam = await as(FAM);
  await fam.goto(B + '/'); await fam.waitForURL('**/client.html'); await fam.waitForSelector('.fn');
  ok((await fam.textContent('#top')).includes(wed.title) && (await fam.$$('.fn')).length === wed.events.length, 'client page shows their functions');
  const f0 = wed.events[0].id;
  await fam.fill('[data-k="' + f0 + '"][data-f="time"]', '19:30'); await fam.fill('[data-k="' + f0 + '"][data-f="venue"]', 'Taj Mahal Hotel'); await fam.fill('[data-k="' + f0 + '"][data-f="address"]', 'Vipin Khand, Gomti Nagar, Lucknow');
  await fam.fill('[data-k="' + f0 + '"][data-f="map"]', 'https://maps.app.goo.gl/abc123'); await fam.fill('[data-k="' + f0 + '"][data-f="contact"]', 'Rahul (brother)'); await fam.fill('[data-k="' + f0 + '"][data-f="phone"]', '9876511111');
  await fam.click('#add-fn'); await fam.fill('[data-k="x0"][data-f="name"]', 'Tilak'); await fam.fill('[data-k="x0"][data-f="date"]', istDay(40)); await fam.fill('[data-k="x0"][data-f="venue"]', 'Home'); await fam.fill('[data-k="x0"][data-f="address"]', 'Indira Nagar'); await fam.fill('[data-k="x0"][data-f="time"]', '11:00');
  await fam.screenshot({ path: path.join(SHOTS, 'client-page.png'), fullPage: false });
  await fam.click('#send'); await fam.waitForFunction(() => /Sent to Muto/.test(document.getElementById('top').textContent));
  const it = T.client_itinerary.get(wed.key);
  ok(it && it.submitted_at && it.data[f0].venue === 'Taj Mahal Hotel' && it.data.extra[0].name === 'Tilak', 'answers and the extra function reach the studio');
  const prev = await as(OWNER);
  await prev.goto(B + '/client.html?k=' + link.token); await prev.waitForSelector('.fn');
  ok((await prev.textContent('#top')).includes('Preview') && await prev.isHidden('#bar') && await prev.$eval('.fn input', x => x.disabled), 'owner can preview the family\'s page but not fill it');
  ok(handle(null, { table: 'client_links', op: 'select', filters: [], order: [] }).error, 'visitors cannot list links');

  // ── 3. owner checks the answers and applies them ──
  await owner.evaluate(() => window.MUTOS_CLIENTS._load()); await owner.evaluate(() => document.dispatchEvent(new Event('mutos:updates'))); await owner.waitForTimeout(400);
  ok((await owner.textContent('#mh-body')).includes('Client itineraries'), 'Home "Needs you" shows client itineraries to check');
  await owner.click('[data-need="clients"]'); await owner.waitForSelector('.sb-modal [data-see="' + wed.key + '"]');
  ok((await owner.textContent('.sb-modal')).includes('New answers to check'), 'Clients shows new answers');
  await owner.click('.sb-modal [data-see="' + wed.key + '"]'); await owner.waitForSelector('.sb-modal [data-apply="' + f0 + '"]');
  await owner.click('.sb-modal [data-apply="' + f0 + '"]');
  const ev0 = await owner.evaluate(id => window.__boardApi.state().events.find(e => e.id === id), f0);
  ok(ev0.location.includes('Taj Mahal Hotel') && ev0.mapLink === 'https://maps.app.goo.gl/abc123' && /From client: starts 19:30 · contact Rahul/.test(ev0.notes), 'Apply to board: venue, map and notes on the shoot');
  const nBefore = await owner.evaluate(() => window.__boardApi.state().events.length);
  await owner.click('.sb-modal [data-add="0"]');
  ok(await owner.evaluate(([n, t, d]) => window.__boardApi.state().events.length === n + 1 && window.__boardApi.state().events.some(e => e.name === t + ' Tilak' && e.date === d && e.location === 'Home, Indira Nagar'), [nBefore, wed.title, istDay(40)]), 'new function added to the board as a shoot');
  await owner.screenshot({ path: path.join(SHOTS, 'client-answers.png') });
  await owner.click('#ca-ok'); await owner.waitForTimeout(500);
  ok(!!T.client_itinerary.get(wed.key).reviewed_at, 'marked as checked');
  await owner.waitForTimeout(4500);
  ok(T.client_feed.get(wed.key).data.functions.length === wed.events.length + 1, 'the family now sees the new function on their link too');

  // ── 4. attendance set-up by the owner ──
  await owner.goto(B + '/attendance.html'); await owner.waitForSelector('#tab-today .hello');
  await owner.click('.tab[data-tab="set"]'); await owner.waitForSelector('#s-here');
  await owner.click('#s-here'); await owner.waitForTimeout(600);
  ok(Math.abs(T.att_settings.get('1').office_lat - OFFICE.latitude) < 1e-6, 'owner sets the office location from the office');
  await owner.fill('#l-email', ACC); await owner.selectOption('#l-role', 'accountant'); await owner.click('#l-add'); await owner.waitForTimeout(300);
  await owner.fill('#l-email', KIOSK); await owner.selectOption('#l-role', 'kiosk'); await owner.click('#l-add'); await owner.waitForTimeout(300);
  ok(role(ACC) === 'accountant' && role(KIOSK) === 'kiosk', 'accountant and office-screen logins added');
  await owner.click('.tab[data-tab="people"]'); await owner.click('#pp-add'); await owner.waitForSelector('#f-email');
  await owner.fill('#f-email', STAFF); await owner.fill('#f-name', 'Neha Office'); await owner.fill('#f-sal', '30000'); await owner.fill('#f-start', '10:00'); await owner.selectOption('#f-off', '0'); await owner.fill('#f-leave', '1'); await owner.fill('#f-join', '2025-04-01');
  await owner.click('.sheet #go'); await owner.waitForTimeout(500);
  ok(T.employees.get(STAFF) && T.employees.get(STAFF).monthly_salary === 30000 && role(STAFF) === 'staff', 'office employee added, with a login');
  await owner.screenshot({ path: path.join(SHOTS, 'att-people.png') });

  // ── 5. the employee checks in at the office ──
  const st = await as(STAFF);
  await st.goto(B + '/'); await st.waitForURL('**/work.html'); await st.waitForSelector('#today .hero');
  ok((await st.textContent('#today')).includes('Not checked in'), 'employee lands on My work');
  await st.click('[data-punch="in"]'); await st.waitForSelector('.sheet #code'); await st.fill('.sheet #code', '000000'); await st.click('.sheet #go'); await st.waitForTimeout(500);
  ok((await st.textContent('#toast')).includes('Wrong or old office code') && T.att_punch.size === 0, 'wrong office code refused');
  await st.click('[data-punch="in"]'); await st.fill('.sheet #code', CODE); await st.click('.sheet #go'); await st.waitForFunction(() => /In office since/.test(document.getElementById('today').textContent));
  ok([...T.att_punch.values()].some(p => p.email === STAFF && p.kind === 'in'), 'checked in with location and code');
  await st.context().setGeolocation(FAR);
  await st.click('[data-punch="lunch_out"]'); await st.fill('.sheet #code', CODE); await st.click('.sheet #go'); await st.waitForTimeout(500);
  ok((await st.textContent('#toast')).includes('not at the office'), 'away from the office → refused');
  await st.context().setGeolocation(OFFICE);
  await st.click('[data-punch="lunch_out"]'); await st.fill('.sheet #code', CODE); await st.click('.sheet #go'); await st.waitForFunction(() => /At lunch since/.test(document.getElementById('today').textContent));
  ok(true, 'lunch break marked');
  await st.screenshot({ path: path.join(SHOTS, 'work-today.png') });
  // requests
  await st.click('.tab[data-tab="req"]'); await st.click('[data-new="advance"]'); await st.fill('#r-amt', '40000'); await st.click('.sheet #go'); await st.waitForTimeout(300);
  ok([...T.att_requests.values()].length === 0, 'advance above one month\'s salary not sent');
  await st.fill('#r-amt', '12000'); await st.fill('#r-why', 'Bike repair'); await st.click('.sheet #go'); await st.waitForTimeout(400);
  await st.click('[data-new="leave"]'); await st.fill('#r-day', istDay(3)); await st.fill('#r-why', 'Family function'); await st.click('.sheet #go'); await st.waitForTimeout(400);
  const reqs = [...T.att_requests.values()];
  ok(reqs.length === 2 && reqs.every(r => r.email === STAFF && r.status === 'pending'), 'advance and leave requests waiting for Ravi');
  await st.screenshot({ path: path.join(SHOTS, 'work-requests.png') });

  // ── 6. owner decides, marks a holiday, runs last month's salary ──
  await owner.goto(B + '/attendance.html'); await owner.waitForSelector('#tab-today .card');
  ok((await owner.textContent('#tab-today')).includes('Neha Office'), 'Today shows who is in');
  await owner.click('.tab[data-tab="req"]'); await owner.waitForSelector('[data-ok]');
  const adv = reqs.find(r => r.kind === 'advance'), lv = reqs.find(r => r.kind === 'leave');
  owner.nextPrompt = '3000'; await owner.click('[data-ok="' + adv.id + '"]'); await owner.waitForTimeout(400);
  await owner.click('[data-ok="' + lv.id + '"]'); await owner.waitForTimeout(400);
  ok(T.att_requests.get(adv.id).status === 'approved' && T.att_requests.get(adv.id).per_month === 3000 && T.att_requests.get(lv.id).status === 'approved', 'owner approves the advance (₹3,000 a month) and the leave');
  await owner.click('.tab[data-tab="hol"]'); await owner.click('#h-add'); await owner.fill('#h-day', istDay(10)); await owner.fill('#h-name', 'Dev Deepawali'); await owner.check('[data-a="' + STAFF + '"]'); await owner.click('.sheet #go'); await owner.waitForTimeout(400);
  ok([...T.holidays.values()].some(h => h.name === 'Dev Deepawali' && h.ask_in.includes(STAFF)), 'holiday marked, with Neha asked to come in');
  // last month's check-ins for Neha
  const last = new Date(Date.UTC(+istDay().slice(0, 4), +istDay().slice(5, 7) - 2, 1)), lm = last.getUTCFullYear() + '-' + pad(last.getUTCMonth() + 1);
  const P = require('../public/payroll.js');
  P.monthDays(lm).filter(d => new Date(d + 'T00:00:00Z').getUTCDay() !== 0).slice(0, 20).forEach((d, i) => {
    const inT = i === 1 || i === 2 || i === 3 ? '10:40' : '09:55', put = (k, t) => { const id = newId(); T.att_punch.set(id, { id, email: STAFF, day: d, kind: k, at: new Date(d + 'T' + t + ':00+05:30').toISOString() }); };
    put('in', inT); put('lunch_out', '13:30'); put('lunch_in', '14:10'); put('out', '19:00');
  });
  await owner.click('.tab[data-tab="pay"]'); await owner.waitForSelector('#tab-pay .tbl');
  const prevShown = await owner.textContent('#tab-pay h2');
  if (Number(istDay().slice(8)) > 10) { await owner.click('#p-prev'); await owner.waitForTimeout(400); }
  const row = await owner.evaluate(() => [...document.querySelectorAll('#tab-pay tbody tr')].map(tr => tr.innerText));
  const expect = P.monthCalc({ emp: T.employees.get(STAFF), month: lm, punches: [...T.att_punch.values()].filter(p => p.email === STAFF && p.day.startsWith(lm)), advances: [T.att_requests.get(adv.id)] });
  ok(row[0].includes('Neha Office') && row[0].includes(String(expect.paidDays)) && expect.lates === 3 && expect.lateCut === 0.5, 'salary for ' + lm + ': ' + expect.paidDays + ' paid days, 3 lates = ½ day cut (' + prevShown + ')');
  await owner.fill('[data-adj="0"]', '500'); await owner.dispatchEvent('[data-adj="0"]', 'change'); await owner.fill('[data-note="0"]', 'Diwali bonus'); await owner.dispatchEvent('[data-note="0"]', 'change');
  await owner.screenshot({ path: path.join(SHOTS, 'att-salary.png') });
  await owner.click('#p-lock'); await owner.waitForSelector('#tab-pay .ans.ok');
  const slip = T.payslips.get(lm + '|' + STAFF);
  ok(T.payroll_runs.get(lm).status === 'locked' && slip && slip.data.net === expect.net + 500, 'month locked; payslip ₹' + (slip && slip.data.net) + ' = salary − ₹3,000 advance + ₹500 bonus');
  ok(T.att_requests.get(adv.id).recovered === 3000, 'advance recovery recorded (₹9,000 left)');
  ok(handle(OWNER, { table: 'payroll_runs', op: 'update', filters: [['eq', 'month', lm]], rows: [{ data: {} }] }).error, 'a locked month cannot change');

  // ── 7. accountant prepares only; employee sees the payslip; office screen shows the code ──
  const acc = await as(ACC, { viewport: { width: 1280, height: 900 } });
  await acc.goto(B + '/'); await acc.waitForURL('**/attendance.html'); await acc.waitForSelector('#tab-today .card');
  await acc.click('.tab[data-tab="req"]'); ok((await acc.$$('[data-ok]')).length === 0, 'accountant cannot approve requests');
  await acc.click('.tab[data-tab="pay"]'); await acc.waitForSelector('#tab-pay .tbl'); ok(!(await acc.$('#p-lock')), 'accountant has no Lock button');
  await st.click('.tab[data-tab="pay"]'); await st.waitForSelector('#slips [data-slip]');
  await st.click('#slips [data-slip]'); await st.waitForSelector('#slip .lines');
  ok((await st.textContent('#slip')).includes('Diwali bonus') && (await st.textContent('#slip')).includes('Advance recovery'), 'employee sees the payslip with every line');
  await st.screenshot({ path: path.join(SHOTS, 'work-payslip.png') });
  const ks = await as(KIOSK, { viewport: { width: 1024, height: 700 } });
  await ks.goto(B + '/'); await ks.waitForURL('**/office.html'); await ks.waitForFunction(c => document.getElementById('code').textContent === c, CODE);
  ok(true, 'office screen shows the check-in code');
  await ks.screenshot({ path: path.join(SHOTS, 'office-screen.png') });
  ok(rpc('att_office_code', {}, STAFF).error, 'employees cannot get the code themselves');

  // ── 8. a shooter who is also an employee gets a Work tab on their crew page ──
  T.members.set(CREWE, { email: CREWE, role: 'crew', person_key: 'hamza', display_name: 'Hamza' });
  T.crew_feed.set('hamza', { person_key: 'hamza', name: 'Hamza', data: { name: 'Hamza', shoots: [] } });
  T.employees.set(CREWE, { email: CREWE, name: 'Hamza', person_key: 'hamza', monthly_salary: 20000, start_time: '10:00', weekly_off: 2, paid_leave: 0, shoot_type: 'B', active: true });
  const cr = await as(CREWE);
  await cr.goto(B + '/'); await cr.waitForURL('**/crew.html'); await cr.waitForSelector('#nav-work:not([hidden])');
  ok(true, 'crew employee sees the Work tab');
  await cr.click('#nav-work'); await cr.waitForURL('**/work.html'); await cr.waitForSelector('#to-shoots:not([hidden])');
  ok(true, '… and My shoots from the Work page');

  // ── 9. work desk: people register, jobs, editors' daily report ──
  const shooterId = n => [...T.docs.values()].filter(r => r.collection === 'shooters' && String(r.data.name).trim().toLowerCase() === n.toLowerCase()).map(r => r.id);
  ['Shrey', 'Adesh', 'Hamza', 'Saif', 'Imran', 'Kaushal'].forEach((n, i) => { const id = crypto.randomUUID(); T.people.set(id, { id, code: 'M' + String(i + 1).padStart(3, '0'), name: n, title: n === 'Imran' ? 'Photo/Album Designer' : 'Video Editor', email: null, phone: null, skills: [], crew_keys: n === 'Hamza' ? ['hamza', ...shooterId('Hamza')] : shooterId(n), active: true }); });
  const PP = n => [...T.people.values()].find(p => p.name === n);
  const PARTNER = 'partner.test@gmail.com', IMRAN = 'imran.album@gmail.com';
  T.members.set(PARTNER, { email: PARTNER, role: 'manager', display_name: 'Partner' });
  owner.on('dialog', dg => dg.accept());
  await owner.goto(B + '/desk.html?tab=people'); await owner.waitForSelector('[data-p]');
  await owner.waitForFunction(() => /Filled 1 Gmail/.test(document.getElementById('toast').textContent));
  ok(PP('Hamza').email === CREWE, 'People: Gmail filled from the crew login (Hamza)');
  ok((await owner.textContent('#tab-people')).includes('M006') && (await owner.textContent('#tab-people')).includes('No Gmail yet'), 'People list shows codes and who cannot sign in yet');
  await owner.click('[data-p="' + PP('Imran').id + '"]'); await owner.waitForSelector('#pe');
  await owner.fill('#pe', 'Imran.Album@gmail.com'); await owner.fill('#pu', 'imran@okhdfc'); await owner.selectOption('#pit', 'Aadhaar'); await owner.fill('#pil', '4321'); await owner.check('#psk input[value="album"]');
  await owner.click('#go'); await owner.waitForSelector('.sheet-bg', { state: 'detached' });
  ok(PP('Imran').email === IMRAN && PP('Imran').skills.includes('album') && (T.people_private.get(PP('Imran').id) || {}).upi === 'imran@okhdfc' && T.people_private.get(PP('Imran').id).id_last4 === '4321', 'owner saves Gmail, skills, UPI and the last 4 ID digits');
  ok((T.members.get(IMRAN) || {}).role === 'staff', 'an office-only editor gets a login');
  await owner.click('#padd'); await owner.fill('#pn', ' Kuldeep '); await owner.fill('#pt', 'Data manager'); await owner.click('#go'); await owner.waitForSelector('.sheet-bg', { state: 'detached' });
  ok((PP('Kuldeep') || {}).code === 'M007', 'a new person gets the next code (M007)');
  // jobs
  await owner.click('.bnav .tab[data-tab="jobs"]'); await owner.click('#add'); await owner.waitForSelector('#aw');
  const wk = await owner.$eval('#aw', s => s.options[1].value); await owner.selectOption('#aw', wk); await owner.waitForSelector('#afn input');
  const nFn = await owner.$$eval('#afn input', x => x.length);
  if (process.env.SHOTS) await owner.screenshot({ path: path.join(SHOTS, 'desk-add.png') });
  await owner.check('#ak input[value="reel"]'); await owner.check('#ak input[value="lr"]'); await owner.selectOption('#ap', PP('Hamza').id); await owner.fill('#ad', istDay(-1));
  await owner.click('#go'); await owner.waitForSelector('.sheet-bg', { state: 'detached' });
  const hj = () => [...T.work_jobs.values()].filter(j => j.assignee === PP('Hamza').id);
  ok(hj().length === 2 && hj().every(j => j.wedding_key === wk && j.event_ids.length === nFn && j.fn_label === null && j.due === istDay(-1) && j.created_by === OWNER), 'owner adds Reel + LR edit for the whole wedding, assigned to Hamza');
  ok((await owner.textContent('#tab-jobs')).includes('overdue') && await owner.$eval('[data-v="overdue"] b', b => b.textContent) === '2', 'jobs past their due date show as overdue');
  await owner.click('#add'); await owner.selectOption('#aw', wk); await owner.waitForSelector('#afn input'); await owner.check('#ak input[value="reel"]'); await owner.click('#go');
  await owner.waitForFunction(() => /already there/.test(document.getElementById('toast').textContent));
  ok(hj().length === 2, 'the same job is not added twice');
  await owner.click('#cx');
  if (process.env.SHOTS) await owner.screenshot({ path: path.join(SHOTS, 'desk-jobs.png'), fullPage: true });
  const sj = crypto.randomUUID(); T.work_jobs.set(sj, { id: sj, wedding_key: wk, wedding_title: 'X', kind: 'trailer', assignee: PP('Saif').id, status: 'todo', progress: 0, count_done: 0, round: 1, event_ids: [] });
  // the editor
  await cr.goto(B + '/crew.html'); await cr.waitForSelector('#nav-jobs:not([hidden])');
  await cr.click('#nav-jobs'); await cr.waitForURL('**/mywork.html'); await cr.waitForSelector('.job');
  ok(await cr.$$eval('.job', x => x.length) === 2, 'Hamza sees only his 2 jobs on My work (not Saif\'s)');
  const reel = hj().find(j => j.kind === 'reel'), lr = hj().find(j => j.kind === 'lr');
  await cr.fill('.job[data-j="' + reel.id + '"] [data-f="progress"]', '40'); await cr.fill('.job[data-j="' + reel.id + '"] [data-f="drive"]', 'M 5');
  await cr.click('.job[data-j="' + reel.id + '"] [data-st="editing"]'); await cr.waitForFunction(() => /Started/.test(document.getElementById('toast').textContent));
  ok(reel.status === 'editing' && reel.progress === 40 && reel.drive === 'M 5' && reel.started_at, 'editor starts the reel with progress and drive');
  if (process.env.SHOTS) await cr.screenshot({ path: path.join(SHOTS, 'mywork-jobs.png'), fullPage: true });
  ok(rpc('x', {}, CREWE) && handle(CREWE, { table: 'work_jobs', op: 'update', filters: [['eq', 'id', reel.id]], rows: [{ status: 'final' }] }).error && handle(CREWE, { table: 'work_jobs', op: 'update', filters: [['eq', 'id', reel.id]], rows: [{ due: '2030-01-01' }] }).error, 'editor cannot mark final or move the due date');
  await cr.click('.bnav .tab[data-tab="rep"]'); await cr.waitForSelector('.rline');
  await cr.check('.rline[data-j="' + reel.id + '"] input[type=checkbox]'); await cr.fill('.rline[data-j="' + reel.id + '"] [data-r="progress"]', '60'); await cr.fill('.rline[data-j="' + reel.id + '"] [data-r="hours"]', '4');
  await cr.check('.rline[data-j="' + lr.id + '"] input[type=checkbox]'); await cr.fill('.rline[data-j="' + lr.id + '"] [data-r="count"]', '350');
  await cr.check('.rline[data-j=""] input[type=checkbox]'); await cr.click('#send');
  await cr.waitForFunction(() => /Write what the other work was/.test(document.getElementById('toast').textContent));
  await cr.fill('.rline[data-j=""] [data-r="note"]', 'Data copy from cards'); await cr.fill('.rline[data-j=""] [data-r="hours"]', '2');
  if (process.env.SHOTS) await cr.screenshot({ path: path.join(SHOTS, 'mywork-report.png'), fullPage: true }); await cr.click('#send');
  await cr.waitForFunction(() => /Report sent/.test(document.getElementById('toast').textContent));
  const reps = [...T.work_reports.values()].filter(r => r.person === PP('Hamza').id);
  ok(reps.length === 3 && reps.every(r => r.day === istDay() && r.by_email === CREWE), 'daily report saved: 2 jobs + other work');
  ok(reel.progress === 60 && lr.count_done === 350 && lr.status === 'editing', 'the report moves the jobs forward (60%, 350 photos, LR started)');
  ok(handle(CREWE, { table: 'work_reports', op: 'insert', rows: [{ person: PP('Saif').id, note: 'fake' }] }).error && handle(CREWE, { table: 'work_reports', op: 'insert', rows: [{ person: PP('Hamza').id, job: sj }] }).error, 'cannot report for someone else or on someone else\'s job');
  // the desk sees it
  await owner.click('.bnav .tab[data-tab="today"]'); await owner.waitForFunction(() => /1 of 7 reported/.test(document.body.textContent));
  const rt = await owner.textContent('#rl');
  ok(rt.includes('Data copy from cards') && rt.includes('350 photos') && /No report yet:.*Saif/.test(rt), 'Reports: Hamza\'s lines and who has not reported');
  if (process.env.SHOTS) await owner.screenshot({ path: path.join(SHOTS, 'desk-reports.png'), fullPage: true });
  await owner.click('.bnav .tab[data-tab="jobs"]'); await owner.click('[data-job="' + reel.id + '"]'); await owner.waitForSelector('#chg');
  await owner.click('#chg'); await owner.waitForFunction(() => /round 2/.test(document.getElementById('toast').textContent));
  ok(reel.status === 'changes' && reel.round === 2, 'client asked for changes: round 2');
  await cr.click('.bnav .tab[data-tab="jobs"]'); await cr.reload(); await cr.waitForSelector('.job.chg [data-st="editing"]');
  ok((await cr.textContent('.job.chg')).includes('Round 2') && await cr.isVisible('#nav-chg'), 'editor sees the changes first, marked Round 2');
  await cr.click('.job.chg [data-st="editing"]'); await cr.waitForFunction(() => /Started/.test(document.getElementById('toast').textContent));
  await cr.click('.job[data-j="' + reel.id + '"] [data-st="rendered"]'); await cr.waitForFunction(() => /rendered/.test(document.getElementById('toast').textContent));
  ok(reel.status === 'rendered' && reel.progress === 100, 'editor marks it rendered (100%)');
  await owner.click('[data-job="' + reel.id + '"]'); await owner.waitForSelector('#fin');
  ok(/60%.*4 h/.test(await owner.textContent('#hist')) || /4 h/.test(await owner.textContent('#hist')), 'the job shows its report history');
  await owner.click('#fin'); await owner.waitForFunction(() => /Final/.test(document.getElementById('toast').textContent));
  ok(reel.status === 'final' && reel.done_at, 'partner/owner marks it final');
  await owner.click('.bnav .tab[data-tab="month"]'); await owner.waitForSelector('.tbl');
  if (process.env.SHOTS) await owner.screenshot({ path: path.join(SHOTS, 'desk-month.png'), fullPage: true });
  const hrow = await owner.$$eval('.tbl tbody tr', rs => rs.map(r => [...r.children].map(td => td.textContent)).find(c => c[0].includes('Hamza')));
  ok(hrow && hrow[1] === '1' && hrow[2] === '6' && hrow[3] === '1' && hrow[4] === '1 Reel' && hrow[5] === '350' && hrow[6] === '1' && hrow[7] === '0%', 'Month: days, hours, finished, photos, change rounds, on time (was due yesterday)');
  // office-only editor, partner, someone not on the list
  const im = await as(IMRAN);
  await im.goto(B + '/'); await im.waitForURL('**/mywork.html'); await im.waitForSelector('#tab-jobs .empty');
  ok((await im.textContent('#sub')).includes('M005'), 'office-only editor signs in and lands on My work with their code');
  await im.click('.bnav .tab[data-tab="me"]'); await im.waitForSelector('#mu'); ok(await im.inputValue('#mu') === 'imran@okhdfc', 'and sees their own private details');
  const pa = await as(PARTNER);
  await pa.goto(B + '/desk.html?tab=people'); await pa.waitForSelector('[data-p]');
  await pa.click('[data-p="' + PP('Imran').id + '"]'); await pa.waitForSelector('#pn');
  ok(!(await pa.$('#pu')), 'the partner sees the register but not UPI, address or ID');
  ok(!handle(PARTNER, { table: 'people_private', op: 'select', filters: [], order: [] }).data.length, 'and cannot read them directly');
  const nobody = await as('random.person@gmail.com');
  await nobody.goto(B + '/mywork.html'); await nobody.waitForFunction(() => /not on Muto's people list/.test(document.body.textContent) || location.pathname === '/');
  ok(true, 'a Gmail not on the people list gets no work page');
  ok(handle(null, { table: 'work_jobs', op: 'select', filters: [], order: [] }).error && handle(null, { table: 'people', op: 'select', filters: [], order: [] }).error, 'visitors see no jobs or people');

  // Attendance → People shows the same People list; attendance is set up from it
  await owner.goto(B + '/attendance.html?tab=people'); await owner.waitForSelector('[data-setup]');
  const att = await owner.textContent('#tab-people');
  ok(/Not set up yet · \d+/.test(att) && att.includes('M005') && att.includes('Kuldeep'), 'Attendance → People lists everyone on the People list who is not set up yet');
  await owner.click('[data-setup="' + PP('Imran').id + '"]'); await owner.waitForSelector('#f-sal');
  ok(await owner.inputValue('#f-name') === 'Imran' && await owner.inputValue('#f-email') === IMRAN, 'Set up opens with the name and Gmail filled in');
  await owner.fill('#f-sal', '30000'); await owner.click('#go'); await owner.waitForSelector('.sheet-bg', { state: 'detached' });
  ok((T.employees.get(IMRAN) || {}).monthly_salary === 30000 && (T.employees.get(IMRAN) || {}).name === 'Imran', 'Imran\'s attendance is set up');
  await owner.click('[data-setup="' + PP('Kuldeep').id + '"]'); await owner.waitForSelector('#f-email'); await owner.fill('#f-email', 'kuldeep.data@gmail.com'); await owner.fill('#f-sal', '15000'); await owner.click('#go'); await owner.waitForSelector('.sheet-bg', { state: 'detached' });
  ok(PP('Kuldeep').email === 'kuldeep.data@gmail.com' && T.employees.get('kuldeep.data@gmail.com'), 'a Gmail typed while setting up also goes on the People list');
  ok((await owner.textContent('#tab-people')).includes('M005'), 'set-up people show their employee code');

  const errs = pages.flatMap(p => p.errs || []);
  ok(!errs.length, 'no page errors ' + errs.slice(0, 3).join(' | '));
  await browser.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
