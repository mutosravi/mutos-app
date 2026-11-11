// End-to-end test of the team app with a fake Supabase (same access rules as schema.sql) and real board data.
// Run: node tests/app.test.js <dir with events/, shooters/, gear/ json dumps>
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..', 'public');
const DATA = process.argv[2];
const OWNER = 'owner.test@gmail.com', MANAGER = 'manager.test@gmail.com';
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// ---------- fake database ----------
const db = { docs: new Map(), members: new Map(), crew_feed: new Map(), crew_away: new Map(), crew_status: new Map(), push_subs: new Map(), gear_feed: new Map(), gear_log: new Map() };
const key = (t, r) => t === 'docs' ? r.collection + '/' + r.id : t === 'members' ? r.email : t === 'crew_away' ? r.id : t === 'crew_status' ? r.person_key + '|' + r.event_id : t === 'push_subs' ? r.endpoint : t === 'gear_feed' || t === 'gear_log' ? r.id : r.person_key;
const pad2 = n => String(n).padStart(2, '0'), dday = o => { const d = new Date(Date.now() + o * 864e5); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
const feedShoots = k => { const f = db.crew_feed.get(k); return (f && f.data && f.data.shoots) || []; };
function load(dir, coll) { const d = path.join(DATA, dir); if (!fs.existsSync(d)) return 0; let n = 0; fs.readdirSync(d).forEach(f => { const data = JSON.parse(fs.readFileSync(path.join(d, f))); const id = data.id || f.replace(/\.json$/, ''); delete data.id; db.docs.set(coll + '/' + id, { collection: coll, id, data, updated_at: new Date(Date.now() - 1e6).toISOString() }); n++; }); return n; }
db.members.set(OWNER, { email: OWNER, role: 'owner', person_key: null, display_name: 'Owner' });
const sessions = new Map(); // browser context -> email
const pages = new Set();
const roleOf = e => { const m = db.members.get(e); return m ? m.role : null; };
const staff = e => ['owner', 'manager'].includes(roleOf(e));
const myKey = e => { const m = db.members.get(e); return m ? m.person_key : null; };
function canSee(t, r, e) {
  if (!e) return false;
  if (t === 'docs') return staff(e);
  if (t === 'members') return r.email === e || roleOf(e) === 'owner';
  if (t === 'crew_feed') return staff(e) || r.person_key === myKey(e);
  if (t === 'crew_away' || t === 'crew_status') return staff(e) || r.person_key === myKey(e);
  if (t === 'push_subs') return r.person_key === myKey(e);
  if (t === 'gear_feed') return desk(e);
  if (t === 'gear_log') return desk(e) || r.person_key === myKey(e);
}
function desk(e) { return ['owner', 'manager', 'gear'].includes(roleOf(e)); }
function canWrite(t, r, e, old) {
  if (!e) return false;
  if (t === 'docs') return staff(e) && (r.collection !== 'seasons' || roleOf(e) === 'owner');
  if (t === 'members') return roleOf(e) === 'owner' && r.role !== 'owner' && !(old && old.role === 'owner');
  if (t === 'crew_feed') return staff(e);
  if (t === 'crew_away') return old ? staff(e) : (staff(e) || (roleOf(e) === 'crew' && r.person_key === myKey(e)));
  if (t === 'crew_status') return staff(e) || (r.person_key === myKey(e) && feedShoots(r.person_key).some(x => x.id === r.event_id));
  if (t === 'push_subs') return r.person_key && r.person_key === myKey(e);
  if (t === 'gear_feed') return staff(e);
  if (t === 'gear_log') return !old && desk(e);
}
// same as the crew_away_rules trigger in 002_crew_actions.sql
function awayRules(r, e) {
  if (staff(e)) return null;
  r.person_key = myKey(e);
  if (r.date < dday(0)) return 'That date has passed.';
  r.why = feedShoots(r.person_key).some(x => x.date === r.date) ? 'booked' : r.date < dday(7) ? 'soon' : '';
  r.status = r.why ? 'pending' : 'auto'; r.id = r.id || 'aw' + Math.random().toString(36).slice(2, 9); r.created_at = new Date().toISOString(); r.slot = r.slot || 'Full day'; r.reason = r.reason || '';
  return null;
}
const match = (r, f) => f.every(([op, c, v]) => op === 'eq' ? r[c] === v : op === 'gte' ? String(r[c] ?? '') >= v : op === 'lte' ? String(r[c] ?? '') <= v : v.includes(r[c]));
const writes = [];
function handle(email, d, srcPage) {
  if (d.op === 'session') return email ? { id: 'u-' + email, email, user_metadata: { full_name: email.split('@')[0] } } : null;
  if (d.op === 'signout') return null;
  const t = db[d.table]; if (!t) return { data: null, error: { message: 'no table ' + d.table } };
  if (!email) return { data: null, error: { message: 'JWT missing', code: '42501' } };
  if (d.op === 'select') {
    let rows = [...t.values()].filter(r => canSee(d.table, r, email) && match(r, d.filters));
    d.order.forEach(([c, asc]) => rows.sort((a, b) => String(a[c] ?? '').localeCompare(String(b[c] ?? '')) * (asc ? 1 : -1)));
    if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1);
    if (d.limit) rows = rows.slice(0, d.limit);
    rows = JSON.parse(JSON.stringify(rows));
    return { data: d.single ? (rows[0] || null) : rows, error: null };
  }
  if (d.op === 'update') {
    const rows = [...t.values()].filter(r => match(r, d.filters) && canSee(d.table, r, email));
    for (const r of rows) { const nr = Object.assign({}, r, d.rows[0]); if (!canWrite(d.table, nr, email, r)) return { data: null, error: { message: 'row-level security', code: '42501' } }; }
    rows.forEach(r => { Object.assign(r, d.rows[0], d.table === 'crew_away' && d.rows[0].status ? { decided_at: new Date().toISOString() } : {}); bc(d.table, r, srcPage); });
    return { data: null, error: null };
  }
  if (d.op === 'insert' && d.table === 'crew_away') {
    for (const r of d.rows) { const err = awayRules(r, email); if (err) return { data: null, error: { message: err } }; if (!canWrite('crew_away', r, email, null)) return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } };
      if ([...t.values()].some(x => x.person_key === r.person_key && x.date === r.date && x.slot === r.slot)) return { data: null, error: { message: 'duplicate key', code: '23505' } }; }
  }
  if (d.op === 'insert' && d.table === 'gear_log') d.rows.forEach(r => { r.id = 'gl' + Math.random().toString(36).slice(2, 10); r.by_email = email; r.created_at = new Date().toISOString(); r.at = r.at || r.created_at; r.qty = r.qty || 1; r.condition = r.condition || 'good'; });
  if (d.op === 'upsert' || d.op === 'insert') {
    for (const r of d.rows) { const k = key(d.table, r), old = t.get(k); if (!canWrite(d.table, r, email, old)) return { data: null, error: { message: 'new row violates row-level security policy', code: '42501' } }; }
    d.rows.forEach(r => { const row = Object.assign({}, t.get(key(d.table, r)) || {}, r, { updated_at: new Date().toISOString() }); t.set(key(d.table, r), row); writes.push([email, d.table, 'up', key(d.table, r)]); if (d.table === 'docs') broadcast(srcPage, { eventType: 'UPDATE', new: row, old: {} }); else bc(d.table, row, srcPage); });
    return { data: null, error: null };
  }
  if (d.op === 'delete') {
    // like Postgres RLS: rows you may not delete are silently left alone
    const canDel = r => d.table === 'gear_log' ? (roleOf(email) === 'owner' || (desk(email) && r.by_email === email)) : d.table === 'crew_away' ? (staff(email) || (r.person_key === myKey(email) && r.date >= dday(0))) : canWrite(d.table, r, email, r);
    [...t.values()].filter(r => match(r, d.filters) && canSee(d.table, r, email) && canDel(r)).forEach(r => { t.delete(key(d.table, r)); writes.push([email, d.table, 'del', key(d.table, r)]); if (d.table === 'docs') broadcast(srcPage, { eventType: 'DELETE', new: {}, old: { collection: r.collection, id: r.id } }); else bc(d.table, r, srcPage); });
    return { data: null, error: null };
  }
}
function bc(table, row, src) { if (table === 'crew_away' || table === 'crew_status' || table === 'gear_log') broadcast(src, { table, eventType: 'UPDATE', new: row, old: {} }); }
function broadcast(src, p) { pages.forEach(pg => { if (pg === src || pg.isClosed()) return; const e = sessions.get(pg.context()); if (!staff(e)) return; pg.evaluate(x => window.__rtFire && window.__rtFire(x), p).catch(() => {}); }); }

// ---------- static server ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const notifyCalls = [];
const server = http.createServer((q, s) => {
  if (q.url === '/api/notify-decision' && q.method === 'POST') { let b = ''; q.on('data', d => { b += d; }); q.on('end', () => { notifyCalls.push(JSON.parse(b)); s.writeHead(200, { 'content-type': 'application/json' }); s.end('{"sent":0}'); }); return; } let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(s); });
const MOCK = fs.readFileSync(path.join(__dirname, 'mock-supabase.js'), 'utf8');

(async () => {
  const n = load('events', 'events') + load('shooters', 'shooters') + load('gear', 'gear') + load('assistants', 'assistants');
  console.log('seeded', n, 'docs');
  await new Promise(r => server.listen(8787, r));
  const B = 'http://localhost:8787';
  const browser = await chromium.launch();
  async function as(email, viewport) {
    const ctx = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } });
    sessions.set(ctx, email);
    await ctx.exposeBinding('__mockCall', (src, d) => { if (d.op === 'signin') { sessions.set(ctx, email); return null; } if (d.op === 'signout') { sessions.set(ctx, null); return null; } return handle(sessions.get(ctx), d, src.page); });
    await ctx.addInitScript(MOCK);
    const page = await ctx.newPage(); pages.add(page);
    const errs = []; page.on('pageerror', e => errs.push(String(e))); page.errs = errs;
    return page;
  }
  const settle = p => p.waitForFunction(() => /Saved to cloud/.test((document.getElementById('sb-sync-text') || document.body).textContent), null, { timeout: 15000 }).catch(() => null);

  // 1. sign-in page
  let p = await as(null);
  await p.goto(B + '/');
  await p.waitForSelector('#signin:not([hidden])');
  ok(true, 'signed out: Google button shown');
  await p.screenshot({ path: path.join(process.env.SHOTS || '.', 'signin.png') });
  await p.context().close();

  p = await as('stranger@gmail.com');
  await p.goto(B + '/');
  await p.waitForSelector('#unknown:not([hidden])');
  ok((await p.textContent('#unk-email')) === 'stranger@gmail.com', 'unknown Google account: asked to send address to Ravi');
  await p.goto(B + '/board.html'); await p.waitForURL(B + '/'); ok(true, 'unknown account sent away from board');
  await p.context().close();

  // 2. owner opens the board
  const owner = await as(OWNER);
  await owner.goto(B + '/');
  await owner.waitForURL('**/board.html');
  await owner.waitForSelector('#mutos-bar');
  // the owner opens on Home: Today, Needs you, Quick menu, Coming up
  await owner.waitForSelector('#mh-desks .desk', { timeout: 20000 });
  ok(await owner.isHidden('#sb-root'), 'owner: opens on Home with the board hidden underneath');
  ok((await owner.$$('#mh-desks .desk')).length === 6 && (await owner.textContent('#mh-body')).includes('Coming up'), 'owner Home: six desks and the coming-up list');
  await owner.click('[data-desk="shoots"]'); await owner.waitForSelector('#mh-desk #mh-tiles .tile');
  ok((await owner.$$('#mh-desk .tile')).length >= 12 && (await owner.textContent('#mh-desk')).includes('Drones & freelancers'), 'Shoots desk opens its tools (board, crew, rentals, call sheet, billing…)');
  await owner.click('#mh-desk .mh-x');
  await owner.waitForTimeout(800);
  await owner.screenshot({ path: path.join(process.env.SHOTS || '.', 'owner-home.png') });
  await owner.click('#mutos-bar [data-mh-view="board"]');
  await owner.waitForFunction(() => document.querySelectorAll('.sb-card, [data-event-id]').length > 0, null, { timeout: 20000 }).catch(() => {});
  await owner.waitForTimeout(1500);
  ok(/#board$/.test(owner.url()) && await owner.isVisible('#sb-root'), 'Board button shows the board');
  await owner.screenshot({ path: path.join(process.env.SHOTS || '.', 'owner-board.png') });
  await settle(owner);
  const syncTxt = await owner.evaluate(() => document.body.innerText.match(/Saved to cloud[^\n]*/)?.[0] || '');
  ok(/Saved to cloud · \d+ shoots/.test(syncTxt), 'owner: board loaded from database (' + syncTxt + ' / ' + await owner.evaluate(() => document.getElementById('sb-sync-text').textContent) + ')');
  await owner.click('#mutos-settings'); await owner.waitForSelector('#mh-more');
  ok((await owner.textContent('#mh-more')).includes('Team logins'), 'owner: Team logins in Settings'); await owner.click('#mh-more .mh-x');

  // 3. give a shooter with upcoming shoots a Login Gmail
  const pick = await owner.evaluate(() => {
    const st = window.__boardApi.state(); const today = window.__boardApi.todayStr();
    const counts = st.shooters.map(p => [p, window.__boardApi.crewFeedFor(window.__boardApi.normalizeName(p.name), today).length]).filter(x => x[1] > 0 && x[0].phone !== undefined).sort((a, b) => b[1] - a[1]);
    return counts.length ? { id: counts[0][0].id, name: counts[0][0].name, n: counts[0][1] } : null;
  }).catch(e => ({ err: String(e) }));
  ok(pick && pick.id, 'found shooter with upcoming shoots: ' + JSON.stringify(pick));
  // move one of their shoots 3 days into the past, for the data-handover check
  const pastId = await owner.evaluate(([name, d]) => { const api = window.__boardApi, k = api.normalizeName(name); const sh = api.crewFeedFor(k, api.todayStr()); const ev = api.state().events.find(e => e.id === sh[sh.length - 1].id); ev.date = d; api.save(); return ev.id; }, [pick.name, dday(-3)]);
  pick.n -= 1;
  await owner.waitForTimeout(1500);
  const CREW = 'crew.member@gmail.com';
  await owner.click('#mutos-bar [data-mh-view="home"]');
  ok(await owner.isVisible('#mutos-home'), 'Home button goes back to Home');
  await owner.click('[data-desk="shoots"]'); await owner.click('#mh-desk [data-tile="sb-manage-shooters"]');
  await owner.waitForSelector('.sb-modal');
  ok(true, 'Crew tile opens Manage shooters on top of Home');
  // open that person's edit form
  const opened = await owner.evaluate(name => { const row = [...document.querySelectorAll('.sb-manage-row')].find(r => { const n = r.querySelector('.sb-manage-name'); return n && n.firstChild && n.firstChild.textContent.trim() === name; }); if (!row) return false; row.querySelector('.act-edit').click(); return true; }, pick.name);
  ok(opened, 'opened edit form');
  await owner.waitForSelector('.sb-modal .ed-email');
  pick.id = (await owner.getAttribute('.sb-modal .ed-email', 'id')).replace('ed-email-', '');
  ok(true, 'Login Gmail field shown in the app board');
  await owner.fill('#ed-email-' + pick.id, 'Crew.Member@Gmail.com ');
  await owner.evaluate(id => { const f = document.getElementById('ed-email-' + id).parentElement; const b = [...f.querySelectorAll('button')].find(x => x.textContent.trim() === 'Save'); b.click(); }, pick.id);
  await owner.waitForTimeout(5500);
  const saved = [...db.docs.values()].find(r => r.collection === 'shooters' && r.id === pick.id);
  ok(saved && saved.data.email === CREW, 'email saved lowercase on the shooter doc: ' + (saved && saved.data.email));
  ok(db.members.get(CREW) && db.members.get(CREW).role === 'crew', 'crew login created: ' + JSON.stringify(db.members.get(CREW)));
  const pkey = db.members.get(CREW) && db.members.get(CREW).person_key;
  const feed = db.crew_feed.get(pkey);
  ok(feed && feed.data.shoots.filter(x => x.date >= dday(0)).length === pick.n && feed.data.shoots.some(x => x.id === pastId), 'crew page written with ' + pick.n + ' upcoming shoots + the recent one');
  const withClient = feed && feed.data.shoots.find(s => s.clientPhone && s.date >= dday(0));
  ok(!!withClient, 'client phone included in crew page data');
  ok(feed && feed.data.shoots.every(s => /photographer|videographer|cinematographer|director|drone|team|assistant|member/i.test(s.role)), 'roles are per-shoot jobs: ' + [...new Set(feed.data.shoots.map(s => s.role))].join(', '));

  // 4. a board change reaches the crew page
  const upcoming = feed.data.shoots.filter(x => x.date >= dday(0)), target = upcoming[0];
  const before = feed.data.updated;
  await owner.evaluate(id => { const ev = window.__boardApi.state().events.find(e => e.id === id); ev.notes = 'Carry extra batteries (test)'; }, target.id);
  await owner.evaluate(() => window.__boardApi.save());
  await owner.waitForTimeout(5500);
  const f2 = db.crew_feed.get(pkey);
  ok(f2.data.shoots.find(x => x.id === target.id).notes === 'Carry extra batteries (test)' && f2.data.updated !== before, 'note change pushed to crew page');

  // 5. crew member signs in
  const crew = await as(CREW, { width: 390, height: 844 });
  await crew.goto(B + '/');
  await crew.waitForURL('**/me.html'); await crew.waitForSelector('[data-go="shoots"]'); ok(true, 'crew land on the team home with My Shoots');
  await crew.click('[data-go="shoots"]'); await crew.waitForURL('**/crew.html');
  await crew.waitForSelector('#next .hero');
  ok((await crew.textContent('#next')).includes(upcoming[0].shoot) && (await crew.$$('#week .wd')).length === 7 && (await crew.$$('#qm .tile')).length >= 5, 'crew Home: next shoot, week strip, quick menu');
  await crew.screenshot({ path: path.join(process.env.SHOTS || '.', 'crew-home.png') });
  await crew.click('.tab[data-tab="shoots"]');
  await crew.waitForSelector('.shoot');
  const cards = await crew.$$eval('#list .shoot', x => x.length);
  ok(cards === pick.n, 'crew sees their ' + cards + ' shoots');
  const txt = await crew.textContent('#list');
  ok(txt.includes('Carry extra batteries (test)'), 'crew sees the studio note');
  ok(withClient && txt.includes(withClient.clientPhone), 'crew sees client number');
  ok(await crew.$('a.chip.wa') !== null, 'WhatsApp client button present');
  ok(await crew.isHidden('#to-board'), 'no board link for crew');
  await crew.screenshot({ path: path.join(process.env.SHOTS || '.', 'crew.png'), fullPage: false });
  const hscroll = await crew.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  ok(!hscroll, 'crew page has no sideways scroll on a phone');
  await crew.goto(B + '/board.html'); await crew.waitForURL('**/me.html'); ok(true, 'crew sent away from the board');
  const leak = handle(CREW, { table: 'docs', op: 'select', filters: [], order: [] }).data.length + handle(CREW, { table: 'crew_feed', op: 'select', filters: [], order: [] }).data.length;
  ok(leak === 1, 'crew can read only their own page (rows visible: ' + leak + ')');

  // 5b. crew actions: confirm, can't make it, calendar, gear, data handover
  await crew.goto(B + '/crew.html'); await crew.click('.tab[data-tab="shoots"]'); await crew.waitForSelector('#list .shoot');
  const second = upcoming[1];
  await crew.click('.shoot[data-id="' + target.id + '"] [data-act="yes"]');
  await crew.waitForTimeout(400);
  ok((db.crew_status.get(pkey + '|' + target.id) || {}).confirm === 'yes', 'crew confirmed a shoot');
  ok(await crew.$('.shoot[data-id="' + target.id + '"] .ans.ok') !== null, 'card shows "You confirmed"');
  await crew.click('.shoot[data-id="' + second.id + '"] [data-act="no"]');
  await crew.fill('.shoot[data-id="' + second.id + '"] .cant textarea', 'Exam that day');
  await crew.click('.shoot[data-id="' + second.id + '"] [data-act="no-send"]');
  await crew.waitForTimeout(400);
  const st2 = db.crew_status.get(pkey + '|' + second.id) || {};
  ok(st2.confirm === 'no' && st2.confirm_note === 'Exam that day', 'crew said can\'t make it with a reason');
  const gcal = await crew.getAttribute('.shoot[data-id="' + target.id + '"] a[href*="calendar.google.com"]', 'href');
  ok(/dates=\d{8}T\d{6}Z\/\d{8}T\d{6}Z/.test(gcal || ''), 'Google Calendar link has start and end times');
  const [dl] = await Promise.all([crew.waitForEvent('download'), crew.click('.shoot[data-id="' + target.id + '"] [data-act="ics"]')]);
  const ics = fs.readFileSync(await dl.path(), 'utf8');
  ok(ics.includes('BEGIN:VEVENT') && ics.includes('DTSTART:') && ics.includes('TRIGGER:-PT3H'), 'phone calendar file with a 3-hour alert (' + dl.suggestedFilename() + ')');
  const gearBtn = await crew.$('.shoot[data-id="' + target.id + '"] [data-act="gear-out"]');
  if (gearBtn) { await gearBtn.click(); await crew.waitForTimeout(400); ok(!!(db.crew_status.get(pkey + '|' + target.id) || {}).gear_out_at, 'gear marked picked up'); }
  await crew.waitForSelector('#recent .shoot[data-id="' + pastId + '"]');
  await crew.fill('#recent .shoot[data-id="' + pastId + '"] [data-role="data-note"]', '2 cards to Ravi');
  await crew.click('#recent .shoot[data-id="' + pastId + '"] [data-act="data"]');
  await crew.waitForTimeout(400);
  ok((db.crew_status.get(pkey + '|' + pastId) || {}).data_note === '2 cards to Ravi', 'data handover marked on the recent shoot');
  const otherEv = [...db.docs.values()].find(r => r.collection === 'events' && !feedShoots(pkey).some(x => x.id === r.id));
  ok(handle(CREW, { table: 'crew_status', op: 'upsert', rows: [{ person_key: pkey, event_id: otherEv.id, confirm: 'yes' }] }).error, 'crew cannot answer for a shoot that is not theirs');
  await crew.screenshot({ path: path.join(process.env.SHOTS || '.', 'crew-actions.png') });

  // 5c. not available dates
  const booked = upcoming.find(x => x.date >= dday(8));
  let free = dday(30); while (feedShoots(pkey).some(x => x.date === free)) free = dday(30 + Math.floor(Math.random() * 30));
  await crew.click('.tab[data-tab="away"]');
  const addAway = async (d, reason) => { await crew.fill('#aw-from', d); await crew.fill('#aw-reason', reason); await crew.waitForTimeout(100); const prev = await crew.textContent('#aw-preview'); await crew.click('#aw-add'); await crew.waitForTimeout(600); return prev; };
  const p1 = await addAway(free, 'Family function');
  ok(/blocked straight away/.test(p1), 'preview says a free far date is blocked straight away');
  const p2 = await addAway(booked.date, 'Sister wedding');
  ok(/You have a shoot/.test(p2), 'preview warns about own shoot on that date');
  let soon = null; for (let i = 1; i < 7 && !soon; i++) if (!feedShoots(pkey).some(x => x.date === dday(i))) soon = dday(i); // a near date with no shoot of theirs
  await addAway(soon, 'Unwell');
  const mine = [...db.crew_away.values()].filter(r => r.person_key === pkey);
  const byDate = d => mine.find(r => r.date === d) || {};
  ok(byDate(free).status === 'auto' && byDate(booked.date).status === 'pending' && byDate(booked.date).why === 'booked' && byDate(soon).why === 'soon', 'statuses: free=auto, booked=pending, soon=pending');
  ok(handle(CREW, { table: 'crew_away', op: 'insert', rows: [{ person_key: 'someone-else', date: dday(75), status: 'approved' }] }).error === null && [...db.crew_away.values()].find(r => r.date === dday(75)).person_key === pkey, 'crew cannot add dates for someone else or forge approval');
  [...db.crew_away.values()].filter(r => r.date === dday(75)).forEach(r => db.crew_away.delete(r.id));
  ok((await crew.textContent('#aw-list')).includes('Waiting for the studio'), 'crew sees requests waiting');
  await crew.screenshot({ path: path.join(process.env.SHOTS || '.', 'crew-away.png') });

  // 5d. owner sees it all in Team updates; free date is already on the board's away list
  await owner.waitForTimeout(2500);
  const mirrored = await owner.evaluate(() => window.__boardApi.state().unavailability.filter(u => String(u.id).startsWith('crew-')).map(u => u.date));
  ok(mirrored.length === 1 && mirrored[0] === free, 'auto date copied to the board away list: ' + mirrored.join(','));
  ok((await owner.textContent('#mutos-upd-n')) === '3', 'Team updates badge shows 3 (2 requests + 1 can\'t make it)');
  await owner.keyboard.press('Escape'); await owner.click('#mutos-updates'); await owner.waitForSelector('.tu-ok');
  const panel = await owner.textContent('.sb-modal');
  ok(panel.includes('Sister wedding') && panel.includes('Booked on') && panel.includes('Exam that day') && panel.includes('2 cards to Ravi') === false, 'panel lists requests and can\'t-make-it');
  ok(gearBtn ? panel.includes('Studio gear with crew (1)') : true, 'panel lists gear out');
  await owner.screenshot({ path: path.join(process.env.SHOTS || '.', 'team-updates.png') });
  const bookedRow = byDate(booked.date), soonRow = byDate(soon);
  await owner.click('.tu-ok[data-id="' + bookedRow.id + '"]'); await owner.waitForTimeout(800);
  await owner.click('.tu-no[data-id="' + soonRow.id + '"]'); await owner.waitForTimeout(800);
  ok(db.crew_away.get(bookedRow.id).status === 'approved' && db.crew_away.get(soonRow.id).status === 'declined', 'owner approved one, declined one');
  const mirrored2 = await owner.evaluate(() => window.__boardApi.state().unavailability.filter(u => String(u.id).startsWith('crew-')).map(u => u.date).sort());
  ok(JSON.stringify(mirrored2) === JSON.stringify([booked.date, free].sort()), 'approved date added to away list, declined not');
  ok(notifyCalls.length === 2 && notifyCalls.some(n => n.id === bookedRow.id) && notifyCalls.some(n => n.id === soonRow.id), 'crew member is told about both decisions');
  await owner.waitForTimeout(1500);
  ok([...db.docs.values()].filter(r => r.collection === 'away' && r.id.startsWith('crew-')).length === 2, 'away list saved to the database');
  await owner.keyboard.press('Escape');
  await crew.reload(); await crew.click('.tab[data-tab="away"]');
  const awTxt = await crew.textContent('#aw-list');
  ok(awTxt.includes('Approved by studio') && awTxt.includes('Declined'), 'crew sees approved and declined');
  // crew takes back the free date → board removes it
  const rm = await crew.$('#aw-list [data-aw="' + byDate(free).id + '"]'); if (!rm) console.log('aw-list:', await crew.innerHTML('#aw-list'), byDate(free)); await rm.click(); await crew.waitForTimeout(2500);
  const mirrored3 = await owner.evaluate(() => window.__boardApi.state().unavailability.filter(u => String(u.id).startsWith('crew-')).map(u => u.date));
  ok(mirrored3.length === 1 && mirrored3[0] === booked.date, 'withdrawn date removed from the board away list ' + JSON.stringify(mirrored3) + ' rows:' + JSON.stringify([...db.crew_away.values()].map(r => r.date + ':' + r.status)));
  ok((await crew.textContent('#decisions')).includes('Day off approved') && (await crew.textContent('#decisions')).includes('Day off not approved'), 'crew page shows the studio\'s answers at the top');
  await crew.click('#decisions [data-seen]'); await crew.waitForTimeout(200);
  ok((await crew.$$('#decisions [data-seen]')).length === 1, 'crew can close an answer once read');
  // a request on a booked day is approved by itself once the owner replaces them on that shoot
  const booked2 = upcoming.find(x => x.date >= dday(8) && x.date !== booked.date && !mine.some(r => r.date === x.date));
  await crew.click('.tab[data-tab="away"]'); await crew.fill('#aw-from', booked2.date); await crew.fill('#aw-reason', 'Cousin wedding'); await crew.fill('#aw-cover', 'Aman'); await crew.click('#aw-add'); await crew.waitForTimeout(800);
  const req2 = [...db.crew_away.values()].find(r => r.person_key === pkey && r.date === booked2.date);
  ok(req2 && req2.status === 'pending' && req2.reason === 'Cousin wedding · Suggests: Aman', 'request with a suggested replacement waits for the studio');
  await owner.waitForTimeout(1200);
  const before2 = notifyCalls.length;
  await owner.evaluate(([name, d]) => { const api = window.__boardApi, k = api.normalizeName(name); api.state().events.filter(e => e.date === d).forEach(e => e.assignments.forEach(a => { const p = api.state().shooters.find(x => x.id === a.memberId); if (p && api.normalizeName(p.name) === k) a.memberId = ''; })); api.save(); }, [pick.name, booked2.date]);
  await owner.waitForTimeout(7000);
  ok(db.crew_away.get(req2.id).status === 'approved', 'replaced on that shoot → request approved automatically');
  ok(notifyCalls.length === before2 + 1 && notifyCalls[notifyCalls.length - 1].id === req2.id && notifyCalls[notifyCalls.length - 1].auto === true, 'and the crew member is told');
  // staff preview is view-only
  const prev = await as(OWNER, { width: 390, height: 844 });
  await prev.goto(B + '/crew.html?preview=1&p=' + pkey); await prev.click('.tab[data-tab="shoots"]'); await prev.waitForSelector('#list .shoot');
  ok((await prev.$$('[data-act="yes"], [data-act="data"], #aw-list [data-aw]')).length === 0, 'staff preview shows no answer buttons');
  await prev.context().close();
  // owner on a phone: Home, bottom bar, More, Board
  const oph = await as(OWNER, { width: 390, height: 844 });
  await oph.goto(B + '/'); await oph.waitForURL('**/board.html'); await oph.waitForSelector('#mh-desks .desk', { timeout: 20000 });
  await oph.waitForTimeout(600);
  ok(await oph.isVisible('.mh-bnav') && await oph.isHidden('#mutos-settings') && !(await oph.evaluate(() => document.documentElement.scrollWidth > innerWidth)), 'owner phone: bottom bar, no sideways scroll');
  await oph.screenshot({ path: path.join(process.env.SHOTS || '.', 'owner-home-phone.png') });
  await oph.screenshot({ path: path.join(process.env.SHOTS || '.', 'owner-home-phone-full.png'), fullPage: true });
  await oph.click('#mh-nav-more'); await oph.waitForSelector('#mh-more');
  ok((await oph.textContent('#mh-more')).includes('Team logins') && (await oph.textContent('#mh-more')).includes('Export to Excel'), 'Settings sheet has logins, backups and files');
  await oph.screenshot({ path: path.join(process.env.SHOTS || '.', 'owner-more-phone.png') });
  await oph.click('#mh-more [data-act="logins"]'); await oph.waitForSelector('#lg-email'); ok(true, 'Team logins opens from Settings');
  await oph.keyboard.press('Escape'); await oph.waitForTimeout(300);
  await oph.click('.mh-bnav [data-mh-view="board"]'); await oph.waitForTimeout(800);
  ok(await oph.isVisible('#sb-root') && await oph.isVisible('#sb-fab'), 'owner phone: Board tab shows the board and Plan button');
  await oph.screenshot({ path: path.join(process.env.SHOTS || '.', 'owner-board-phone.png') });
  await oph.goBack(); await oph.waitForTimeout(300);
  ok(await oph.isVisible('#mutos-home'), 'phone Back button returns from Board to Home');
  await oph.context().close();

  // 6. owner adds a manager in Team logins
  await owner.keyboard.press('Escape'); await owner.waitForTimeout(300);
  await owner.click('#mutos-settings'); await owner.click('#mh-more [data-act="logins"]');
  await owner.waitForSelector('#lg-email');
  await owner.fill('#lg-name', 'Test Manager'); await owner.fill('#lg-email', MANAGER); await owner.click('#lg-add');
  await owner.waitForTimeout(800);
  ok(roleOf(MANAGER) === 'manager', 'manager added');
  const loginsTxt = await owner.textContent('.sb-modal');
  ok(loginsTxt.includes(CREW) && loginsTxt.includes('No Login Gmail yet'), 'logins window lists crew and who is missing');
  await owner.screenshot({ path: path.join(process.env.SHOTS || '.', 'logins.png') });
  await owner.click('#lg-done');

  // 6b. Gear desk: owner adds a gear manager, who hands out and takes back gear
  const GEAR = 'gear.desk@gmail.com';
  await owner.click('#mutos-settings'); await owner.click('#mh-more [data-act="logins"]'); await owner.waitForSelector('#lg-gemail');
  await owner.fill('#lg-gname', 'Desk Person'); await owner.fill('#lg-gemail', GEAR); await owner.click('#lg-gadd'); await owner.waitForTimeout(800);
  ok(roleOf(GEAR) === 'gear', 'owner added a gear manager');
  await owner.keyboard.press('Escape');
  await owner.evaluate(() => window.MUTOS_APP._push()); await owner.waitForTimeout(1500);
  const gf = db.gear_feed.get('main');
  ok(gf && gf.data.items.length > 0 && gf.data.shoots.length > 0 && !JSON.stringify(gf.data).includes('Client '), 'board shared the gear schedule, without client details');
  const gearShoot = gf.data.shoots.find(x => x.date >= dday(0) && x.carriers.some(cr => cr.key === pkey && cr.gear.length)) ;
  ok(!!gearShoot, 'found a shoot where ' + pick.name + ' carries studio gear: ' + (gearShoot && gearShoot.shoot));
  const gp = await as(GEAR, { width: 390, height: 844 });
  await gp.goto(B + '/'); await gp.waitForURL('**/gear.html');
  ok(true, 'gear manager lands on the Gear desk');
  await gp.goto(B + '/board.html'); await gp.waitForURL('**/gear.html'); ok(true, 'gear manager cannot open the board');
  ok(handle(GEAR, { table: 'docs', op: 'select', filters: [], order: [] }).data.length === 0 && handle(GEAR, { table: 'crew_feed', op: 'select', filters: [], order: [] }).data.length === 0, 'gear manager reads no board data or crew pages');
  await gp.waitForSelector('#sum .stat');
  ok((await gp.$$('#sum .stat')).length === 4 && await gp.isVisible('#free-out'), 'gear Home: four counters and Hand out any gear');
  await gp.screenshot({ path: path.join(process.env.SHOTS || '.', 'gear-home.png') });
  await gp.click('.tab[data-tab="day"]');
  await gp.waitForSelector('#d-date'); await gp.fill('#d-date', gearShoot.date); await gp.dispatchEvent('#d-date', 'change');
  await gp.waitForSelector('[data-give="' + pkey + '"]');
  await gp.click('[data-give="' + pkey + '"]'); await gp.waitForSelector('.sheet');
  await gp.fill('#sh-note', '2 batteries, charger'); await gp.click('#sh-save'); await gp.waitForTimeout(700);
  const outs = [...db.gear_log.values()].filter(l => l.action === 'out' && l.person_key === pkey);
  ok(outs.length >= 1 && outs.every(l => l.by_email === GEAR && l.event_id === gearShoot.id && l.note === '2 batteries, charger'), 'handed out ' + outs.map(l => l.gear_name).join(', ') + ', signed by the desk');
  ok(await gp.$('[data-give="' + pkey + '"]') === null && (await gp.textContent('#day')).includes('✓ With'), 'day view now shows the gear is with them');
  await gp.screenshot({ path: path.join(process.env.SHOTS || '.', 'gear-day.png'), fullPage: false });
  await gp.click('.tab[data-tab="out"]');
  ok((await gp.textContent('#outlist')).includes(pick.name), 'Out now lists them');
  await gp.click('#outlist [data-recv="' + pkey + '"]'); await gp.waitForSelector('.sheet');
  await gp.click('.conds button[data-c="damaged"]'); await gp.click('#sh-save'); await gp.waitForTimeout(300);
  ok(await gp.$('.sheet') !== null, 'damaged without a note is not accepted');
  await gp.fill('#sh-note', 'LCD cracked'); await gp.click('#sh-save'); await gp.waitForTimeout(700);
  const ins = [...db.gear_log.values()].filter(l => l.action === 'in' && l.person_key === pkey);
  ok(ins.length === outs.length && ins.every(l => l.condition === 'damaged' && l.note === 'LCD cracked'), 'received back, marked damaged with note');
  ok((await gp.textContent('#sum')).includes('damaged'), 'damage shows at the top of the desk');
  await gp.click('.tab[data-tab="items"]'); ok((await gp.textContent('#items')).includes('LCD cracked'), 'Items shows the damage note');
  await gp.screenshot({ path: path.join(process.env.SHOTS || '.', 'gear-items.png'), fullPage: false });
  // hand out again and pass straight on to someone else
  await gp.click('.tab[data-tab="day"]'); await gp.waitForSelector('[data-give="' + pkey + '"]');
  ok((await gp.textContent('#day')).includes('⚠ Damaged: LCD cracked'), 'day view warns the item came back damaged');
  ok(await gp.$eval('.carrier [data-pick]:not(:checked)', el => !!el).catch(() => false), 'damaged item is not ticked by default');
  await gp.evaluate(() => document.querySelectorAll('.carrier [data-pick]').forEach(cb => { cb.checked = true; }));
  await gp.click('[data-give="' + pkey + '"]'); await gp.waitForSelector('.sheet'); await gp.click('#sh-save'); await gp.waitForTimeout(700);
  await gp.click('.tab[data-tab="out"]'); await gp.click('#outlist [data-recv="' + pkey + '"]'); await gp.waitForSelector('#sh-pass');
  const other = gf.data.people.find(p2 => p2.key !== pkey);
  await gp.selectOption('#sh-pass', other.key); await gp.click('#sh-save'); await gp.waitForTimeout(700);
  ok((await gp.textContent('#outlist')).includes(other.name) && !(await gp.textContent('#outlist')).includes(pick.name + 'Receive'), 'passed straight on to ' + other.name);
  await gp.click('.tab[data-tab="log"]');
  const logTxt = await gp.textContent('#log');
  ok(logTxt.includes('Passed on from') && logTxt.includes('by gear.desk'), 'log shows every step and who entered it');
  await gp.screenshot({ path: path.join(process.env.SHOTS || '.', 'gear-log.png'), fullPage: false });
  // instant shoot: any item to someone not on the board, plus an item not on the gear list
  await gp.click('.tab[data-tab="home"]'); await gp.click('#free-out'); await gp.waitForSelector('#fs-person');
  await gp.selectOption('#fs-person', '__new'); await gp.fill('#fs-newname', 'Rohit Freelancer');
  await gp.fill('#fs-for', 'Instant shoot · cafe promo');
  await gp.fill('#fs-q', gf.data.items[2].name); await gp.check('#fs-items input[data-it="' + gf.data.items[2].id + '"]');
  await gp.fill('#fs-other', '4 extra batteries'); await gp.click('#fs-addother');
  await gp.click('#fs-save'); await gp.waitForTimeout(700);
  const inst = [...db.gear_log.values()].filter(l => l.person_key === 'guest:rohit-freelancer');
  ok(inst.length === 2 && inst.some(l => l.gear_id === 'other:4-extra-batteries') && inst.every(l => /For: Instant shoot · cafe promo/.test(l.note) && !l.event_id), 'instant shoot: board item + unlisted item to someone not on the board');
  ok((await gp.textContent('#day')).includes('Rohit Freelancer'), 'day view lists the instant-shoot hand-out');
  await gp.click('.tab[data-tab="out"]');
  ok((await gp.textContent('#outlist')).includes('4 extra batteries'), 'Out now shows it, ready to receive back');
  await gp.click('#outlist [data-recv="guest:rohit-freelancer"]'); await gp.waitForSelector('.sheet'); await gp.click('#sh-save'); await gp.waitForTimeout(700);
  ok([...db.gear_log.values()].filter(l => l.person_key === 'guest:rohit-freelancer' && l.action === 'in').length === 2, 'received back from the instant shoot');
  ok(handle(CREW, { table: 'gear_log', op: 'insert', rows: [{ gear_id: 'x', gear_name: 'x', action: 'in', person_key: pkey, person_name: 'x' }] }).error, 'crew cannot write the gear log');
  // crew sees the desk record on that shoot
  await crew.goto(B + '/crew.html'); await crew.click('.tab[data-tab="shoots"]'); await crew.waitForSelector('#list .shoot');
  const gtxt = await crew.textContent('.shoot[data-id="' + gearShoot.id + '"]');
  ok(gtxt.includes('Gear desk gave you') && gtxt.includes('damaged'), 'crew sees what the desk gave them and the damage note');

  // 7. manager edits; live update reaches the owner's open board
  const mgr = await as(MANAGER);
  await mgr.goto(B + '/'); await mgr.waitForURL('**/board.html'); await mgr.waitForSelector('#mutos-bar');
  await mgr.waitForTimeout(2500);
  await mgr.click('#mutos-settings'); await mgr.waitForSelector('#mh-more');
  ok(!(await mgr.textContent('#mh-more')).includes('Team logins'), 'manager: no Team logins in Settings'); await mgr.click('#mh-more .mh-x');
  await mgr.evaluate(id => { const ev = window.__boardApi.state().events.find(e => e.id === id); ev.notes = 'Changed by manager'; }, target.id);
  await mgr.evaluate(() => window.__boardApi.save());
  await mgr.waitForTimeout(1500);
  const ownerSees = await owner.evaluate(id => window.__boardApi.state().events.find(e => e.id === id).notes, target.id);
  ok(ownerSees === 'Changed by manager', 'owner board updated live from manager edit');
  await mgr.waitForTimeout(4500);
  ok(db.crew_feed.get(pkey).data.shoots.find(x => x.id === target.id).notes === 'Changed by manager', 'manager edit pushed to crew page');
  ok(roleOf(CREW) === 'crew', 'manager did not touch logins');

  // 8. owner removes the Login Gmail: login and page are removed
  await owner.evaluate(id => { delete window.__boardApi.state().shooters.find(p => p.id === id).email; }, pick.id);
  await owner.evaluate(() => window.__boardApi.save());
  await owner.waitForTimeout(5500);
  ok(!db.members.has(CREW) && !db.crew_feed.has(pkey), 'login and crew page removed with the email');
  ok(db.members.get(OWNER).role === 'owner' && roleOf(MANAGER) === 'manager', 'owner and manager logins untouched');

  // 9. sign out
  await owner.click('#mutos-out'); await owner.waitForURL(B + '/'); await owner.waitForSelector('#signin:not([hidden])'); ok(true, 'sign out returns to sign-in');

  const errs = [...pages].flatMap(pg => pg.errs || []);
  ok(!errs.length, 'no page errors ' + errs.slice(0, 3).join(' | '));
  await browser.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); [...pages].forEach(pg => (pg.errs || []).length && console.error("page errors:", pg.errs.slice(0, 5))); process.exit(1); });
