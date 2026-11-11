// Memory cards, end to end on phones (public/cards.html + the rules of supabase/014_cards.sql, mirrored by a small fake).
// Owner adds cards → gives four to the supervisor → he gives three to Shrey → Shrey writes notes, passes one to Saif,
// returns the rest → the office accepts → owner marks copied (amber) then backup (green) → Shrey sees where it went.
// Run: node tests/cards.test.js        (SHOTS=<folder> for screenshots)
const path = require('path'), fs = require('fs'), http = require('http'), crypto = require('crypto'); const { chromium } = require('playwright');
process.chdir(path.resolve(__dirname, '..'));
const ROOT = path.resolve('public'), SHOTS = process.env.SHOTS || ''; const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => crypto.randomUUID(), now = () => new Date().toISOString();
const istDay = (n = 0) => new Date(Date.now() + 330 * 60000 + n * 864e5).toISOString().slice(0, 10);

// ── data ──
const T = { members: new Map(), people: new Map(), cards: new Map(), card_moves: new Map(), card_uses: new Map(), card_copies: new Map(), card_log: new Map(), drives: new Map(), drive_items: new Map(), docs: new Map(), crew_feed: new Map() };
const OWNER = 'o@x.com', SUP = 's@x.com', SHREY = 'shrey@x.com', SAIF = 'saif@x.com';
[[OWNER, 'owner', null], [SUP, 'supervisor', null], [SHREY, 'crew', 'shrey'], [SAIF, 'crew', 'saif']].forEach(([email, role, person_key]) => T.members.set(email, { email, role, person_key }));
const P = {}; [['Ravi', OWNER], ['Vikas', SUP], ['Shrey', SHREY], ['Saif', SAIF], ['Hamza', 'hamza@x.com']].forEach(([name, email], i) => { const id = uid(); P[name] = id; T.people.set(id, { id, code: 'M00' + (i + 1), name, email, active: true, skills: [] }); });
[['M 5', 'SSD'], ['Dibba 2', 'HDD']].forEach(([name, kind]) => { const id = uid(); T.drives.set(id, { id, name, kind, status: 'in_use' }); });
const ev = { id: 'ev-haldi', name: 'Sharma Haldi', wedding: 'Sharma', date: istDay(-1), slot: 'Morning', status: 'confirmed', assignments: [], equipmentIds: [], assistantIds: [] };
T.docs.set('events/' + ev.id, { collection: 'events', id: ev.id, data: ev });
T.crew_feed.set('shrey', { person_key: 'shrey', name: 'Shrey', data: { shoots: [{ id: ev.id, date: ev.date, shoot: ev.name, wedding: 'Sharma' }] } });

// ── rules (same as 014_cards.sql) ──
const role = e => (T.members.get(e) || {}).role, staff = e => ['owner', 'manager'].includes(role(e)), desk = e => staff(e) || role(e) === 'supervisor';
const personOf = e => { const p = [...T.people.values()].find(x => x.email === e && x.active); return p ? p.id : null; };
const pname = id => id ? T.people.get(id).name : 'the office';
const isDeskPerson = id => { const p = T.people.get(id); return !!(p && ['owner', 'manager', 'supervisor'].includes(role(p.email))); };
const log = (card, by, what) => { const id = uid(); T.card_log.set(id, { id, card, at: now(), by_email: by, what }); };
const err = m => ({ error: m });
function rpc(fn, a, e) {
  const me = personOf(e);
  if (fn === 'people_directory') return (staff(e) || me) ? [...T.people.values()].filter(p => p.active).map(p => ({ id: p.id, code: p.code, name: p.name, keeper: false })) : [];
  if (fn === 'card_give') {
    const ks = a.p_cards.map(id => T.cards.get(id)), batch = uid(), single = [];
    for (const k of ks) {
      if (!((k.holder == null && desk(e)) || (k.holder && k.holder === me) || (k.holder && staff(e)))) return err('Only whoever has ' + k.code + ' (or the office) can give it.');
      if (k.condition !== 'ok') return err(k.code + ' is marked ' + k.condition + '.');
      if ((a.p_to || null) === (k.holder || null)) return err('already has it');
      if (k.holder == null && k.data === 'hold') return err(k.code + ' has footage that is not copied yet. Copy it before giving it out.');
      if (k.data === 'single' && k.holder == null) single.push(k.code);
    }
    ks.forEach(k => { [...T.card_moves.values()].filter(m => m.card === k.id && m.status === 'pending').forEach(m => { m.status = 'cancelled'; }); const id = uid(); T.card_moves.set(id, { id, card: k.id, batch, from_person: k.holder, to_person: a.p_to || null, status: 'pending', note: a.p_note, given_by: e, given_by_person: me, given_at: now() }); log(k.id, e, pname(k.holder) + ' → ' + pname(a.p_to) + ': given'); });
    return { ok: true, batch, count: ks.length, single_copy: single };
  }
  if (fn === 'card_answer') {
    let n = 0;
    for (const id of a.p_moves) {
      const m = T.card_moves.get(id); if (!m || m.status !== 'pending') continue;
      if (!((m.to_person && m.to_person === me) || (!m.to_person && staff(e)))) return err('This handover is not for you.');
      const k = T.cards.get(m.card); m.status = a.p_accept ? 'accepted' : 'declined';
      if (a.p_accept) {
        if (m.from_person == null && ['single', 'copied'].includes(k.data)) Object.assign(k, { data: 'empty', data_since: null, cycle: k.cycle + 1, with_team: false });
        k.holder = m.to_person; k.with_team = k.with_team || (m.to_person != null && !isDeskPerson(m.to_person));
        if (m.to_person == null && k.data === 'empty' && k.with_team && ![...T.card_uses.values()].some(u => u.card === k.id && u.cycle === k.cycle)) Object.assign(k, { data: 'hold', data_since: now() });
      }
      log(k.id, e, pname(m.to_person) + (a.p_accept ? ' accepted ' : ' did not accept ') + k.code); n++;
    }
    return n ? { ok: true, count: n } : err('These handovers are no longer waiting.');
  }
  if (fn === 'card_cancel') { a.p_moves.forEach(id => { const m = T.card_moves.get(id); if (m && m.status === 'pending' && (m.given_by === e || staff(e))) m.status = 'cancelled'; }); return { ok: true }; }
  if (fn === 'card_use') {
    const k = T.cards.get(a.p_card);
    if (!((k.holder && k.holder === me) || desk(e))) return err('Only whoever has ' + k.code + ' can write its notes.');
    if (a.p_used && !String(a.p_shoot || '').trim()) return err('Pick the shoot this card was used for.');
    if (a.p_used && !a.p_media) return err('Photo or video?');
    if (a.p_used && ['single', 'copied'].includes(k.data)) Object.assign(k, { data: 'empty', cycle: k.cycle + 1 });
    const id = uid(); T.card_uses.set(id, { id, card: k.id, cycle: k.cycle, used: a.p_used, event_id: a.p_event, shoot: a.p_shoot, wedding: a.p_wedding, media: a.p_used ? a.p_media : null, style: a.p_used ? a.p_style : null, camera: a.p_camera, note: a.p_note, by_email: e, by_person: me, at: now() });
    if (a.p_used && k.data === 'empty') Object.assign(k, { data: 'hold', data_since: now() });
    log(k.id, e, a.p_used ? 'Used: ' + a.p_shoot : 'Marked not used'); return { ok: true, id };
  }
  if (fn === 'card_copy') {
    if (!staff(e)) return err('Only the owner or the manager can mark a card copied.');
    const k = T.cards.get(a.p_card), d = T.drives.get(a.p_drive);
    if (!['hold', 'single'].includes(k.data)) return err('nothing to copy');
    if (!(a.p_files >= 1)) return err('Write how many files were copied (count them on the drive).');
    if (!String(a.p_folder || '').trim()) return err('Write the folder on the drive.');
    const backup = k.data === 'single';
    if (backup) { const f = [...T.card_copies.values()].find(x => x.card === k.id && x.cycle === k.cycle && !x.backup); if (f && f.drive === d.id) return err('The backup must be on a different drive from the first copy.'); }
    const items = (a.p_items && a.p_items.length ? a.p_items : [{ title: 'Card ' + k.code }]).map(it => { const id = uid(); T.drive_items.set(id, { id, drive: d.id, wedding_key: it.wedding_key || null, title: it.title, what: backup ? 'backup' : 'raw', note: 'from card ' + k.code + ' · ' + a.p_folder + ' · ' + a.p_files + ' files' }); return id; });
    const id = uid(); T.card_copies.set(id, { id, card: k.id, cycle: k.cycle, backup, drive: d.id, drive_name: d.name, folder: a.p_folder, files: a.p_files, size_label: a.p_size, items, by_email: e, at: now() });
    Object.assign(k, { data: backup ? 'copied' : 'single', data_since: null }); log(k.id, e, (backup ? 'Backup copied to ' : 'Copied to ') + d.name); return { ok: true, backup };
  }
  if (fn === 'card_mark_empty') { if (!staff(e)) return err('no'); Object.assign(T.cards.get(a.p_card), { data: 'empty' }); return { ok: true }; }
  if (fn === 'card_problem') {
    const k = T.cards.get(a.p_card);
    if (['error', 'damaged', 'lost'].includes(a.p_kind) && !((k.holder && k.holder === me) || desk(e))) return err('Only whoever has ' + k.code + ' can report it.');
    if (['found', 'ok', 'retired'].includes(a.p_kind) && !staff(e)) return err('Only the owner or the manager can change this.');
    if (a.p_kind === 'error') { k.errors++; if (k.errors >= 2) k.condition = 'retired'; } else if (['damaged', 'lost', 'retired'].includes(a.p_kind)) k.condition = a.p_kind; else k.condition = 'ok';
    log(k.id, e, 'problem ' + a.p_kind); return { ok: true };
  }
  return err('unknown rpc ' + fn);
}
const readable = (t, e) => ['cards', 'card_moves', 'card_uses', 'card_copies', 'card_log', 'drives'].includes(t) ? desk(e) || !!personOf(e) : t === 'people' ? true : t === 'docs' ? desk(e) : t === 'crew_feed' ? true : t === 'members' ? true : false;
function handle(e, d) {
  if (d.op === 'session') return e ? { id: 'u-' + e, email: e, user_metadata: { full_name: e } } : null;
  if (d.op === 'rpc') { const r = rpc(d.fn, d.args, e); return { data: r, error: null }; }
  if (d.op === 'signout' || d.op === 'signin') return { data: null, error: null };
  const t = T[d.table]; if (!t) return { data: d.single ? null : [], error: null };
  const match = r => d.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v : op === 'in' ? v.includes(r[c]) : op === 'gte' ? String(r[c]) >= v : op === 'lte' ? String(r[c]) <= v : op === 'is' ? r[c] == v : true);
  if (d.op === 'select') {
    if (!readable(d.table, e)) return { data: d.single ? null : [], error: null };
    let rows = [...t.values()].filter(match);
    if (d.table === 'members' && !staff(e)) rows = rows.filter(r => r.email === e);
    if (d.table === 'crew_feed' && !staff(e)) rows = rows.filter(r => r.person_key === (T.members.get(e) || {}).person_key);
    if (d.table === 'docs') rows = rows.map(r => ({ collection: r.collection, id: r.id, data: r.data }));
    if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1);
    return { data: d.single ? rows[0] || null : JSON.parse(JSON.stringify(rows)), error: null };
  }
  if (d.table === 'cards' && d.op === 'insert') {
    if (!staff(e)) return { data: null, error: { message: 'row-level security' } };
    for (const r of d.rows) if ([...t.values()].some(k => k.code.toLowerCase() === r.code.trim().toLowerCase())) return { data: null, error: { message: 'duplicate key' } };
    d.rows.forEach(r => { const id = uid(); t.set(id, Object.assign({ id, holder: null, data: 'empty', data_since: null, condition: 'ok', errors: 0, cycle: 1, with_team: false, notes: null }, r, { code: r.code.trim() })); log(id, e, 'Added'); });
    return { data: null, error: null };
  }
  if (d.table === 'cards' && d.op === 'update') { if (!staff(e)) return { data: null, error: null }; [...t.values()].filter(match).forEach(k => Object.assign(k, d.rows[0])); return { data: null, error: null }; }
  return { data: null, error: { message: 'not allowed in this test: ' + d.op + ' ' + d.table } };
}

const notices = [];
const server = http.createServer((q, s) => { if (q.url === '/api/notify-card') { let b = ''; q.on('data', x => { b += x; }); q.on('end', () => { notices.push(JSON.parse(b)); s.writeHead(200, { 'content-type': 'application/json' }); s.end('{"sent":1}'); }); return; } let p = q.url.split('?')[0]; if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(s); });
(async () => {
  await new Promise(r => server.listen(8847, r));
  const B = 'http://localhost:8847', b = await chromium.launch(), errs = [];
  async function phone(email) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route(/fonts\.googleapis|fonts\.gstatic/, r => r.abort());
    await ctx.exposeBinding('__mockCall', (src, d) => handle(email, d));
    await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8'));
    await ctx.addInitScript(() => { try { sessionStorage.setItem('mutos-stay-old', '1'); } catch (e) {} });
    const p = await ctx.newPage(); p.on('pageerror', x => errs.push(email + ': ' + x)); p.on('dialog', dl => dl.accept(dl.type() === 'prompt' ? 'checked: empty' : undefined));
    return p;
  }
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  const K = code => [...T.cards.values()].find(k => k.code === code);
  const open = async (p, tab) => { await p.goto(B + '/cards.html' + (tab ? '?tab=' + tab : '')); await p.waitForFunction(() => !/Loading/.test(document.getElementById('sub').textContent)); };
  const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, n), fullPage: true }); };
  const pick = async (p, code) => p.check('[data-c="' + K(code).id + '"] [data-sel]');

  // ── the owner adds cards by pasting the list ──
  const o = await phone(OWNER);
  await open(o, 'all');
  ok(await o.isVisible('.bnav .tab[data-tab="copy"]') && await o.isVisible('#add-cards'), 'owner: All cards, To copy, ＋ Add cards');
  await o.click('#add-cards');
  await o.fill('#a-txt', 'Code\tType\tSize\tBrand\tSerial\nC01\tCFexpress B\t256 GB\tSony\tSN-1\nC02, SD, 128 GB, SanDisk, SN-2\nC03, sd, 128 GB, SanDisk,\nC04, micro SD, 64 GB, Lexar, SN-4');
  ok(/4 cards/.test(await o.textContent('#a-prev')), 'the paste is read: 4 cards (header line skipped)');
  await o.click('#a-go'); await o.waitForSelector('.crow');
  ok(T.cards.size === 4 && K('C01').kind === 'CFexpress B' && K('C04').kind === 'microSD' && K('C03').serial === null, 'four cards saved with their types and serials');
  ok((await o.$$('.crow.green')).length === 4, 'all green: free in the office');
  await o.click('#add-cards'); await o.fill('#a-txt', 'c02, SD, 64 GB'); await o.click('#a-go');
  ok(/Already in the list: c02/i.test(await o.textContent('#toast')) && T.cards.size === 4, 'a code already in the list is refused');
  await o.click('.sheet-bg', { position: { x: 5, y: 5 } });
  // ── bulk to the supervisor ──
  for (const c of ['C01', 'C02', 'C03', 'C04']) await pick(o, c);
  ok(/4 picked/.test(await o.textContent('#selbar')), 'four cards picked');
  await o.click('#sel-give'); await o.selectOption('#g-to', P.Vikas); await o.fill('#g-note', 'weekend shoots'); await o.click('#g-go');
  await o.waitForFunction(() => /waiting for them to accept/.test(document.getElementById('inbox').textContent));
  ok([...T.card_moves.values()].filter(m => m.status === 'pending').length === 4 && new Set([...T.card_moves.values()].map(m => m.batch)).size === 1 && !K('C01').holder, 'one handover of four cards; still in the office until he accepts');

  const s = await phone(SUP);
  await open(s);
  ok(/4 cards for you: C01, C02, C03, C04/.test(await s.textContent('#inbox')), 'supervisor sees the four cards waiting for him');
  await s.click('[data-acc]'); await s.waitForFunction(() => !document.querySelector('[data-acc]'));
  ok([...T.cards.values()].every(k => k.holder === P.Vikas), 'he accepts all four with one tap');
  await sleep(300);
  const b1 = [...T.card_moves.values()][0].batch;
  ok(notices.some(n => n.kind === 'give' && n.batch === b1) && notices.some(n => n.kind === 'answer' && n.moves.length === 4), 'phone notices: one when given (to him), one when he accepted (to the owner)');
  ok(!(await s.isVisible('.bnav .tab[data-tab="copy"]')), 'no "To copy" for the supervisor');
  await s.click('.bnav .tab[data-tab="mine"]');
  for (const c of ['C01', 'C02', 'C03']) await pick(s, c);
  await s.click('#sel-give'); await s.selectOption('#g-to', P.Shrey); await s.click('#g-go'); await sleep(300);

  // ── team leader ──
  const sh = await phone(SHREY);
  await open(sh);
  ok(await sh.isVisible('.bnav .tab[data-tab="mine"]') && !(await sh.isVisible('.bnav .tab[data-tab="copy"]')) && !(await sh.$('#add-cards')), 'team leader: My cards; no copying, no adding');
  await sh.click('[data-acc]'); await sh.waitForSelector('.crow');
  ok((await sh.$$('#tab-mine .crow.blue')).length === 3, 'three cards with Shrey (blue: out)');
  await shot(sh, 'cards-leader.png');
  // notes: C01 and C02 together, then C03 not used
  await pick(sh, 'C01'); await pick(sh, 'C02'); await sh.click('#sel-note');
  ok(/Sharma Haldi/.test(await sh.textContent('#n-shoot')), 'the shoot list has his shoots from the board');
  await sh.click('#n-save'); ok(/Photo or video/.test(await sh.textContent('#toast')), 'Photo or video is asked');
  await sh.check('input[name="n-media"][value="photo"]'); await sh.check('input[name="n-style"][value="candid"]'); await sh.fill('#n-cam', 'Z9'); await sh.fill('#n-note', 'family portraits');
  await shot(sh, 'cards-note.png');
  await sh.click('#n-save'); await sh.waitForFunction(() => !document.querySelector('.sheet-bg'));
  ok(K('C01').data === 'hold' && K('C02').data === 'hold' && [...T.card_uses.values()].filter(u => u.shoot === 'Sharma Haldi' && u.media === 'photo').length === 2, 'notes saved on both; they turn red (hold)');
  ok((await sh.$$('#tab-mine .crow.red')).length === 2, 'red on his screen too');
  await sh.click('[data-c="' + K('C03').id + '"]'); await sh.click('#k-note'); await sh.click('#n-unused'); await sh.waitForFunction(() => !document.querySelector('.sheet-bg'));
  ok(K('C03').data === 'empty' && [...T.card_uses.values()].some(u => u.card === K('C03').id && !u.used), 'C03 marked not used: stays empty');
  // passes C02 to Saif (another leader), returns C01 + C03 to the office
  await pick(sh, 'C02'); await sh.click('#sel-give');
  ok(await sh.$('#g-to option[value="office"]'), 'he can give back to the office…');
  await sh.selectOption('#g-to', P.Saif); await sh.click('#g-go'); await sleep(300);
  await pick(sh, 'C01'); await pick(sh, 'C03'); await sh.click('#sel-give'); await sh.selectOption('#g-to', 'office'); await sh.click('#g-go'); await sleep(300);
  const sa = await phone(SAIF); await open(sa); await sa.click('[data-acc]'); await sleep(300);
  ok(K('C02').holder === P.Saif && K('C02').data === 'hold', '… and pass a card straight to another team leader (it stays red)');

  // ── the office copies ──
  await open(o);
  ok(/2 cards for the office: C01, C03/.test(await o.textContent('#inbox')), 'the office sees the returned cards');
  await o.click('[data-acc]'); await sleep(300);
  ok(!K('C01').holder && !K('C03').holder, 'owner accepts them into the office');
  await open(o, 'copy');
  ok((await o.$$('#tab-copy .crow.red')).length === 2, 'To copy: C01 and C02 (C02 still with Saif)');
  await shot(o, 'cards-to-copy.png');
  await o.click('#tab-copy [data-c="' + K('C01').id + '"]'); await o.click('#k-copy');
  ok(/Sharma · Haldi \(Photo candid\)/.test(await o.textContent('.sheet')), 'the drive line is made from Shrey\'s notes');
  await o.fill('#cp-drive', 'M 5'); await o.fill('#cp-folder', 'Sharma/Haldi/Candid'); await o.click('#cp-go');
  ok(/how many files/.test(await o.textContent('#toast')), 'copied needs the number of files');
  await o.fill('#cp-files', '812'); await o.fill('#cp-size', '120 GB'); await o.click('#cp-go'); await o.waitForFunction(() => !document.querySelector('.sheet-bg'));
  const m5 = [...T.drives.values()].find(d => d.name === 'M 5'), d2 = [...T.drives.values()].find(d => d.name === 'Dibba 2');
  ok(K('C01').data === 'single' && [...T.drive_items.values()].some(i => i.drive === m5.id && i.wedding_key === 'w:sharma' && i.title === 'Sharma · Haldi (Photo candid)' && /812 files/.test(i.note)), 'C01 copied: amber, and M 5\'s list got "Sharma · Haldi" by itself');
  await open(o, 'copy');
  ok(/Backup pending \(1\)/.test(await o.textContent('#tab-copy')) && (await o.$$('#tab-copy .crow.amber')).length === 1, 'it moves to "Backup pending" (amber)');
  await o.click('#tab-copy .crow.amber'); await o.click('#k-copy');
  ok(await o.inputValue('#cp-folder') === 'Sharma/Haldi/Candid' && await o.inputValue('#cp-files') === '812', 'backup form starts from the first copy');
  await o.fill('#cp-drive', 'M 5'); await o.click('#cp-go');
  ok(/different drive from the first copy/.test(await o.textContent('#toast')), 'the backup cannot go on the first copy\'s drive');
  await o.fill('#cp-drive', 'Dibba 2'); await o.click('#cp-go'); await o.waitForFunction(() => !document.querySelector('.sheet-bg'));
  ok(K('C01').data === 'copied' && [...T.drive_items.values()].some(i => i.drive === d2.id && i.what === 'backup'), 'backup done: C01 is green');

  // ── Shrey checks ──
  await open(sh, 'mine');
  const used = await sh.textContent('#used-list');
  ok(/C01/.test(used) && /Copied to M 5/.test(used) && /812 files/.test(used) && /Backup on Dibba 2/.test(used) && /C02[\s\S]*Not copied yet/.test(used), 'Shrey sees where C01 went (M 5 + backup Dibba 2) and that C02 is not copied yet');
  await shot(sh, 'cards-check.png');

  // ── going out again: a new round, the old copy stays ──
  await open(o, 'all');
  await o.click('[data-c="' + K('C01').id + '"]');
  ok(/M 5/.test(await o.textContent('.sheet')) && /Dibba 2/.test(await o.textContent('.sheet')), 'card sheet: where it was copied');
  await o.click('#k-give'); await o.selectOption('#g-to', P.Hamza); await o.click('#g-go'); await sleep(200);
  K('C01').holder = null; // (Hamza has no phone in this test; the rule is checked in rls_cards.sql)
  // a card back from a team without notes
  await open(sa); await pick(sa, 'C02'); await sa.click('#sel-give'); await sa.selectOption('#g-to', 'office'); await sa.click('#g-go'); await sleep(200);
  await open(o); await o.click('[data-acc]'); await sleep(300);
  ok(K('C02').data === 'hold', 'C02 is still red in the office until copied');
  // single-copy warning when giving out
  await open(o, 'copy'); await o.click('[data-c="' + K('C02').id + '"]'); await o.click('#k-copy'); await o.fill('#cp-drive', 'M 5'); await o.fill('#cp-folder', 'Sharma/Haldi/Cine'); await o.fill('#cp-files', '40'); await o.click('#cp-go'); await sleep(300);
  await open(o, 'all'); await pick(o, 'C02'); await o.click('#sel-give');
  ok(/only one copy, backup not done yet/.test(await o.textContent('.sheet')), 'giving out a single-copy card shows a gentle warning');
  await o.click('#g-cx');
  // problems
  await o.click('[data-c="' + K('C04').id + '"]');
  ok(!(await o.$('#k-copy')), 'nothing to copy on an empty card');
  await o.click('#k-close');
  await open(s, 'mine'); await s.click('[data-c="' + K('C04').id + '"]'); await s.click('#k-prob'); await s.fill('#pb-n', 'read error'); await s.click('#pb-go'); await sleep(300);
  await s.click('[data-c="' + K('C04').id + '"]'); await s.click('#k-prob'); await s.click('#pb-go'); await sleep(300);
  ok(K('C04').condition === 'retired', 'two errors: C04 retired');
  ok(await s.$('[data-c="' + K('C04').id + '"].grey') && !(await s.$('[data-c="' + K('C04').id + '"] [data-sel]')), 'shown grey and cannot be given out');
  await shot(o, 'cards-all.png');

  ok(errs.length === 0, 'no page errors ' + errs.slice(0, 3).join(' | '));
  await b.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
