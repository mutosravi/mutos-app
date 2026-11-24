// Sales desk, end to end (public/sales.html + bill.html, rules of supabase/041_sales.sql mirrored by a small fake).
// Admin adds a bank account → makes a quotation from the board's functions → books it (bill) → records a payment →
// an expense → a GST invoice to another state → the family opens the share link → a payment is cancelled.
// Run: node tests/sales.test.js        (SHOTS=<folder> for screenshots)
const path = require('path'), fs = require('fs'), http = require('http'), crypto = require('crypto'), vm = require('vm'); const { chromium } = require('playwright');
process.chdir(path.resolve(__dirname, '..'));
const ROOT = path.resolve('public'), SHOTS = process.env.SHOTS || ''; const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => crypto.randomUUID(), now = () => new Date().toISOString();
const istDay = (n = 0) => new Date(Date.now() + 330 * 60000 + n * 864e5).toISOString().slice(0, 10);
const sb = { window: {} }; vm.runInNewContext(fs.readFileSync('public/sales-core.js', 'utf8'), sb); const SC = sb.window.MutosSales;

// ── data ──
const T = { members: new Map(), docs: new Map(), sales_settings: new Map(), sales_series: new Map(), sale_items: new Map(), parties: new Map(), sales_docs: new Map(), bank_accounts: new Map(), money_txns: new Map(), sales_log: new Map() };
const OWNER = 'o@x.com', MGR = 'm@x.com', SUP = 's@x.com';
[[OWNER, 'owner'], [MGR, 'manager'], [SUP, 'supervisor']].forEach(([email, role]) => T.members.set(email, { email, role }));
T.sales_settings.set(1, { id: 1, data: { name: "Muto's Films", state: 'Uttar Pradesh', address: 'Gomti Nagar, Lucknow', pay_terms: '30% Booking Amount; 60% Before Event; 10% During Final Delivery', quote_days: 15, terms: '4- Short Event … maximum 5 hours' } });
[['quotation', 'MTF2026-', 27245], ['invoice', 'MF/SL/26-27/', 157], ['gst_invoice', 'MF/G/26-27/', 21], ['purchase', 'PUR-', 1], ['in', 'IN-', 231], ['out', 'OUT-', 82], ['expense', 'EXP-', 341], ['transfer', 'TR-', 1]].forEach(([kind, prefix, next]) => T.sales_series.set(kind, { kind, prefix, next }));
[['Wedding (Standard)', 'standard', 'Wedding', 180000, null], ['Engagement/Sangeet/Reception (Standard)', 'standard', 'Function', 55000, null], ['Short Event (Standard)', 'standard', 'Short event', 15000, 5],
 ['Wedding (Premium)', 'premium', 'Wedding', 260000, null], ['Short Event (Premium)', 'premium', 'Short event', 24000, 5], ['Album 50 Sheets', null, 'Album', 20000, null], ['Corporate event', null, 'Event', 10000, null]].forEach(([name, tier, category, price, hours], i) => {
  const id = uid(); T.sale_items.set(id, { id, name, tier, category, price, hours, unit: 'SSN', gst_rate: 18, team: tier ? '1 Candid Photographer, 1 Cinematographer' : null, deliverables: tier ? '25 Edited photographs' : null, active: true, sort: i });
});
[{ id: 'ev-haldi', name: 'Sharma Haldi', wedding: 'Sharma', date: istDay(30), slot: 'Morning', eventType: 'short', location: 'Home, Gomti Nagar' },
 { id: 'ev-wed', name: 'Sharma Wedding', wedding: 'Sharma', date: istDay(31), slot: 'Evening', location: 'Taj, Lucknow' }].forEach(x => T.docs.set('events/' + x.id, { collection: 'events', id: x.id, data: Object.assign({ status: 'confirmed', assignments: [] }, x) }));

// ── rules (same as 041_sales.sql) ──
const role = e => (T.members.get(e) || {}).role, staff = e => ['owner', 'manager'].includes(role(e));
const next = k => { const s = T.sales_series.get(k); const n = s.prefix + s.next; s.next++; return n; };
const log = (e, what) => { const id = T.sales_log.size + 1; T.sales_log.set(id, { id, at: now(), by_email: e, what }); };
const paidOf = id => [...T.money_txns.values()].filter(m => m.status === 'ok').reduce((a, m) => a + (m.alloc || []).filter(x => x.doc === id).reduce((b, x) => b + Number(x.amount), 0), 0);
function docRules(n, old, e) {
  const tiers = new Set((n.lines || []).map(l => l.tier).filter(Boolean)); if (tiers.size > 1) return 'Standard and Premium packages cannot be on one bill.';
  const home = T.sales_settings.get(1).data.state, p = T.parties.get(n.party) || {};
  n.supply_state = n.supply_state || p.state || home;
  Object.assign(n, SC.calc(n.lines, n.kind, n.supply_state.toLowerCase() === home.toLowerCase()));
  n.paid = paidOf(n.id); if (n.paid > n.total + 0.5) return 'Already paid more: the bill cannot be less than that.';
  if (old && old.status === 'cancelled') return 'This one is cancelled.';
  if (n.status === 'cancelled' && !String(n.cancel_why || '').trim()) return 'Write why it is cancelled.';
  if (n.status === 'cancelled' && n.paid > 0) return 'Payments are linked to it.';
  return null;
}
function moneyRules(n, old) {
  if (old && old.status === 'cancelled') return 'This payment is cancelled.';
  if (n.status === 'cancelled' && !String(n.cancel_why || '').trim()) return 'Write why it is cancelled.';
  if (n.kind === 'expense' && !String(n.category || '').trim()) return 'Pick what the expense was for.';
  let tot = 0;
  for (const a of n.alloc || []) { const d = T.sales_docs.get(a.doc); if (!d || d.party !== n.party) return 'Bill belongs to another party.'; tot += Number(a.amount); }
  if (tot > n.amount + 0.001) return 'Linked bills add up to more than the payment.';
  return null;
}
function recount() { for (const d of T.sales_docs.values()) { d.paid = paidOf(d.id); if (d.paid > d.total + 0.5) return 'More than the bill ' + d.number + ' would be paid.'; } return null; }
function handle(e, d) {
  if (d.op === 'session') return e ? { id: 'u-' + e, email: e, user_metadata: { full_name: e } } : null;
  if (d.op === 'signout' || d.op === 'signin') return { data: null, error: null };
  if (d.op === 'rpc') {
    if (d.fn === 'sales_doc_view') {
      const x = [...T.sales_docs.values()].find(y => y.token === d.args.p_token && y.kind !== 'purchase');
      if (!x || x.status === 'cancelled') return { data: { error: 'This link is not valid any more.' }, error: null };
      const p = T.parties.get(x.party), s = T.sales_settings.get(1).data;
      return { data: Object.assign({}, x, { party: { name: p.name, gstin: p.gstin, address: p.address, state: p.state }, company: Object.assign({}, s, { gstin: x.kind === 'gst_invoice' ? s.gstin : null }),
        banks: [...T.bank_accounts.values()].filter(b => b.on_bills && b.active && b.kind === 'bank').map(b => ({ name: b.name, bank: b.bank, acc_no: b.acc_no, ifsc: b.ifsc, upi: b.upi })) }), error: null };
    }
    return { data: null, error: { message: 'no rpc ' + d.fn } };
  }
  const t = T[d.table]; if (!t) return { data: d.single ? null : [], error: null };
  const match = r => d.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v || String(r[c]) === String(v) : op === 'in' ? v.includes(r[c]) : true);
  const isSales = d.table !== 'docs' && d.table !== 'members';
  if (d.op === 'select') {
    if (isSales && !staff(e)) return { data: d.single ? null : [], error: null };
    if (d.table === 'docs' && !['owner', 'manager', 'supervisor'].includes(role(e))) return { data: [], error: null };
    let rows = [...t.values()].filter(match);
    if (d.table === 'members') rows = rows.filter(r => r.email === e);
    if (d.table === 'docs') rows = rows.map(r => ({ collection: r.collection, id: r.id, data: r.data }));
    if (d.table === 'sales_log') rows.sort((a, b) => b.id - a.id);
    if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1); if (d.limit) rows = rows.slice(0, d.limit);
    rows = JSON.parse(JSON.stringify(rows.slice(0, 1000)));
    return { data: d.single ? rows[0] || null : rows, error: null };
  }
  if (!staff(e)) return { data: null, error: { message: 'new row violates row-level security policy' } };
  if (d.op === 'insert') {
    const out = [];
    for (const r0 of d.rows) {
      const r = JSON.parse(JSON.stringify(r0)), id = uid();
      if (d.table === 'parties') { if (r.gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(r.gstin)) return { data: null, error: { message: 'violates check constraint "parties_gstin_check"' } }; Object.assign(r, { id, opening: r.opening || 0, kind: r.kind || 'customer', active: true, created_by: e, created_at: now() }); }
      else if (d.table === 'bank_accounts') Object.assign(r, { id, kind: r.kind || 'bank', opening: Number(r.opening) || 0, opening_on: r.opening_on || istDay(), active: true, sort: 0, created_at: now() });
      else if (d.table === 'sale_items') Object.assign(r, { id, active: true, sort: 99 });
      else if (d.table === 'sales_docs') {
        Object.assign(r, { id, number: r.number || next(r.kind), token: uid().replace(/-/g, ''), status: 'open', paid: 0, created_by: e, created_at: now(), doc_date: r.doc_date || istDay() });
        const m = docRules(r, null, e); if (m) { T.sales_series.get(r.kind).next--; return { data: null, error: { message: m } }; }
        if (r.from_doc && T.sales_docs.get(r.from_doc) && T.sales_docs.get(r.from_doc).kind === 'quotation') T.sales_docs.get(r.from_doc).status = 'converted';
        log(e, 'Made ' + r.kind + ' ' + r.number + ' · ₹' + r.total);
      } else if (d.table === 'money_txns') {
        Object.assign(r, { id, number: r.number || next(r.kind), status: 'ok', created_by: e, created_at: now(), alloc: r.alloc || [], txn_date: r.txn_date || istDay() });
        const m = moneyRules(r, null); if (m) return { data: null, error: { message: m } };
        t.set(id, r); const m2 = recount(); if (m2) { t.delete(id); recount(); return { data: null, error: { message: m2 } }; }
        log(e, 'Recorded ' + r.kind + ' ' + r.number + ' · ₹' + r.amount);
      } else return { data: null, error: { message: 'not allowed in this test: insert ' + d.table } };
      t.set(id, r); out.push(r);
    }
    return { data: d.single ? JSON.parse(JSON.stringify(out[0])) : JSON.parse(JSON.stringify(out)), error: null };
  }
  if (d.op === 'update') {
    const rows = [...t.values()].filter(match); const out = [];
    for (const r of rows) {
      const n = Object.assign(JSON.parse(JSON.stringify(r)), d.rows[0]);
      if (d.table === 'sales_docs') { n.kind = r.kind; n.token = r.token; const m = docRules(n, r, e); if (m) return { data: null, error: { message: m } }; log(e, (n.status === 'cancelled' ? 'Cancelled ' : 'Changed ') + n.kind + ' ' + n.number); }
      if (d.table === 'money_txns') { n.kind = r.kind; const m = moneyRules(n, r); if (m) return { data: null, error: { message: m } }; const keep = JSON.parse(JSON.stringify(r)); Object.assign(r, n); const m2 = recount(); if (m2) { Object.assign(r, keep); recount(); return { data: null, error: { message: m2 } }; } log(e, (n.status === 'cancelled' ? 'Cancelled ' : 'Changed ') + n.kind + ' ' + n.number + (n.cancel_why ? ': ' + n.cancel_why : '')); out.push(r); continue; }
      if (d.table === 'sales_series' && role(e) !== 'owner') return { data: null, error: { message: 'permission denied' } };
      Object.assign(r, n); out.push(r);
    }
    return { data: d.single ? JSON.parse(JSON.stringify(out[0] || null)) : null, error: null };
  }
  return { data: null, error: { message: 'not allowed in this test: ' + d.op + ' ' + d.table } };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((q, s) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(ROOT, p); if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(s); });
(async () => {
  await new Promise(r => server.listen(8849, r));
  const B = 'http://localhost:8849', b = await chromium.launch(), errs = [];
  async function as(email, vp) {
    const ctx = await b.newContext({ viewport: vp || { width: 1280, height: 900 } });
    await ctx.route(/fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr/, r => r.abort());
    await ctx.exposeBinding('__mockCall', (src, d) => handle(email, d));
    await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8'));
    await ctx.addInitScript(() => { try { sessionStorage.setItem('mutos-stay-old', '1'); } catch (e) {} });
    const p = await ctx.newPage(); p.on('pageerror', x => errs.push((email || 'anon') + ': ' + x)); p.on('popup', pp => pp.close().catch(() => {}));
    return p;
  }
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, n), fullPage: true }); };
  const toastHas = (p, re) => p.waitForFunction(r => new RegExp(r).test(document.getElementById('toast').textContent), re.source, { timeout: 8000 });
  const D = (kind, nth = 0) => [...T.sales_docs.values()].filter(x => x.kind === kind)[nth];
  const top = p => p.locator('.sheet-bg').last();

  const o = await as(OWNER);
  await o.goto(B + '/sales.html'); await o.waitForSelector('#h-collect');
  ok(/Add your bank accounts/.test(await o.textContent('#tab-home')), 'Sales desk opens for the admin: asks to add accounts first');

  // a bank account with today's balance, printed on bills
  await o.click('#tab-home [data-new="account"]'); await o.waitForSelector('#ba-name');
  await o.fill('#ba-name', 'HDFC Current'); await o.fill('#ba-open', '100000'); await o.fill('#ba-bank', 'HDFC Bank'); await o.fill('#ba-no', '50200012344521'); await o.fill('#ba-ifsc', 'hdfc0001234'); await o.check('#ba-bills');
  await o.click('#ba-save'); await toastHas(o, /Saved/);
  ok(/₹1,00,000/.test(await o.textContent('#h-cash')), 'the account shows on Home: cash + bank ₹1,00,000');

  // quotation for the board's client, lines from the board
  await o.click('#tab-home [data-new="quotation"]'); await o.waitForSelector('#de-party');
  await o.fill('#de-party', 'Mr Sharma'); await o.dispatchEvent('#de-party', 'input');
  ok(await o.isVisible('#de-ph-l'), 'a new name asks for the phone');
  await o.fill('#de-phone', '9876543210'); await o.fill('#de-client', 'Sharma');
  await o.click('#de-fill'); await o.waitForSelector('#de-lines [data-i="1"]');
  const names = await o.$$eval('#de-lines [data-k="name"]', xs => xs.map(x => x.value).filter(Boolean));
  ok(names.join('|') === 'Short Event (Standard)|Wedding (Standard)', 'Fill from the board: Haldi → Short Event, Wedding → Wedding (Standard) (' + names.join(', ') + ')');
  ok(await o.inputValue('#de-lines [data-i="0"] [data-k="hours"]') === '5' && /Gomti/.test(await o.inputValue('#de-lines [data-i="0"] [data-k="place"]')), 'the short event gets 5 hours and the venue from the board');
  await o.fill('#de-lines [data-i="1"] [data-k="disc"]', '10');
  ok(/₹1,77,000/.test(await o.textContent('#de-tot')), 'the total updates as you type: 15,000 + 1,80,000 less 10 % = 1,77,000');
  await o.click('#de-save'); await toastHas(o, /Made quotation MTF2026-27245/);
  const q = D('quotation');
  ok(q && q.total === 177000 && q.lines.length === 2 && q.wedding_key === 'w:sharma', 'quotation MTF2026-27245 saved (₹1,77,000, linked to the Sharma client)');
  ok([...T.parties.values()].some(p => p.name === 'Mr Sharma' && p.phone === '9876543210' && p.wedding_key === 'w:sharma'), 'the new party is added with phone and client link');
  await o.waitForSelector('.preview .mdoc');
  ok(/QUOTATION/.test(await o.textContent('.preview')) && /50200012344521/.test(await o.textContent('.preview')) && /One Lakh Seventy Seven Thousand Rupees Only/.test(await o.textContent('.preview')), 'the preview shows the quotation, the bank to pay and the amount in words');
  await shot(o, 'sales-quote.png');

  // booked → bill
  await o.click('#dv-bill'); await o.waitForSelector('#de-save');
  await o.click('#de-save'); await toastHas(o, /Made bill MF\/SL\/26-27\/157/);
  const inv = D('invoice');
  ok(inv && inv.total === 177000 && inv.from_doc === q.id && T.sales_docs.get(q.id).status === 'converted', 'bill MF/SL/26-27/157 made from it; the quotation is now Booked');

  // payment against the bill
  await o.click('#dv-pay'); await o.waitForSelector('#pf-amt');
  ok(await o.inputValue('#pf-amt') === '177000', 'Record payment starts with the balance');
  await o.fill('#pf-amt', '50000'); await o.click('#pf-auto'); await o.fill('#pf-ref', 'UTR998877');
  await o.click('#pf-save'); await toastHas(o, /IN-231/);
  ok(T.sales_docs.get(inv.id).paid === 50000, 'the bill shows ₹50,000 paid');
  await o.click('.bnav .tab[data-tab="home"]'); await o.waitForSelector('#h-cash');
  ok(/₹1,50,000/.test(await o.textContent('#h-cash')) && /₹1,27,000/.test(await o.textContent('#h-collect')), 'Home: bank ₹1,50,000 and ₹1,27,000 to collect');

  // an expense
  await o.click('#tab-home [data-new="expense"]'); await o.waitForSelector('#pf-cat');
  await o.fill('#pf-amt', '3000'); await o.click('#pf-save'); await toastHas(o, /What was it for/);
  await o.fill('#pf-cat', 'Transportation & Travel'); await o.click('#pf-save'); await toastHas(o, /EXP-341/);
  await o.waitForSelector('#h-cash');
  ok(/₹1,47,000/.test(await o.textContent('#h-cash')), 'an expense takes it down to ₹1,47,000');

  // GST invoice to a company in Delhi
  await o.click('.bnav .tab[data-tab="gst"]'); await o.waitForSelector('#g-csv');
  await o.click('#tab-gst [data-new="gst_invoice"]'); await o.waitForSelector('#de-state');
  await o.fill('#de-party', 'Grand Hotel Pvt Ltd'); await o.dispatchEvent('#de-party', 'input'); await o.fill('#de-state', 'Delhi'); await o.dispatchEvent('#de-state', 'input');
  await o.fill('#de-lines [data-i="0"] [data-k="name"]', 'Corporate event'); await o.dispatchEvent('#de-lines [data-i="0"] [data-k="name"]', 'change');
  await o.waitForFunction(() => document.querySelector('#de-lines [data-k="rate"]').value === '10000');
  ok(/IGST/.test(await o.textContent('#de-tot')) && /₹11,800/.test(await o.textContent('#de-tot')), 'GST invoice to Delhi: IGST 18 % added (₹11,800)');
  await o.click('#de-save'); await toastHas(o, /MF\/G\/26-27\/21/);
  const g = D('gst_invoice');
  ok(g && g.igst === 1800 && g.cgst === 0 && g.total === 11800, 'saved as MF/G/26-27/21 with IGST');
  await o.click('.mutos-pageback, .sheet-bg .x, #dv-copyas').catch(() => {});
  await o.evaluate(() => document.querySelectorAll('.sheet-bg').forEach(x => x.remove()));
  await o.click('.bnav .tab[data-tab="gst"]'); await o.waitForSelector('#tab-gst .tbl');
  ok(/MF\/G\/26-27\/21/.test(await o.textContent('#tab-gst')) && !/MF\/SL/.test(await o.textContent('#tab-gst .tbl')), 'the GST view lists only GST invoices');

  // Standard and Premium cannot be mixed
  await o.click('.bnav .tab[data-tab="bills"]'); await o.click('#tab-bills [data-k="quotation"]'); await o.click('#tab-bills [data-new="quotation"]'); await o.waitForSelector('#de-party');
  await o.fill('#de-party', 'Mr Sharma');
  await o.fill('#de-lines [data-i="0"] [data-k="name"]', 'Wedding (Premium)'); await o.dispatchEvent('#de-lines [data-i="0"] [data-k="name"]', 'change');
  await o.click('#de-add'); await o.fill('#de-lines [data-i="1"] [data-k="name"]', 'Short Event (Standard)'); await o.dispatchEvent('#de-lines [data-i="1"] [data-k="name"]', 'change');
  ok(await o.waitForFunction(() => /cannot be on one bill/.test((document.getElementById('de-tot') || {}).textContent || ''), null, { timeout: 5000 }).then(() => true, () => false), 'mixing Standard and Premium shows a warning');
  await o.click('#de-save'); await toastHas(o, /cannot be on one bill/);
  ok([...T.sales_docs.values()].filter(x => x.kind === 'quotation').length === 1, 'and is not saved');
  await o.evaluate(() => document.querySelectorAll('.sheet-bg').forEach(x => x.remove()));

  // the family opens the share link (no sign-in)
  const fam = await as(null, { width: 390, height: 844 });
  await fam.goto(B + '/bill.html?t=' + inv.token); await fam.waitForSelector('.mdoc');
  const ft = await fam.textContent('.mdoc');
  ok(/MF\/SL\/26-27\/157/.test(ft) && /Received/.test(ft) && /₹1,27,000/.test(ft) && /HDFC0001234/.test(ft), 'the family opens the bill link: number, received, balance ₹1,27,000 and the bank to pay');
  ok(!/GSTIN/.test(ft), 'a plain bill shows no GSTIN');
  ok(await fam.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the bill fits a phone screen');
  await shot(fam, 'sales-bill-phone.png');
  await fam.goto(B + '/bill.html?t=nope'); await fam.waitForSelector('.msg');
  ok(/not valid/.test(await fam.textContent('.msg')), 'a wrong link shows nothing');

  // parties: who owes what
  await o.click('.bnav .tab[data-tab="parties"]'); await o.click('#tab-parties [data-v="collect"]');
  ok(/Mr Sharma/.test(await o.textContent('#tab-parties')) && /₹1,39,000/.test(await o.textContent('#tab-parties')) === false && /₹1,27,000/.test(await o.textContent('#tab-parties')), 'Parties → To collect: Mr Sharma ₹1,27,000');

  // cancel the payment: reason needed, bill and bank go back
  await o.click('.bnav .tab[data-tab="money"]'); await o.waitForSelector('#tab-money .lrow');
  const pay = [...T.money_txns.values()].find(x => x.kind === 'in');
  await o.click('#tab-money [data-txn="' + pay.id + '"]'); await o.click('#tx-cancel'); await o.waitForSelector('#aw-go');
  await o.click('#aw-go'); await toastHas(o, /Write why/);
  await o.fill('#aw-why', 'cheque bounced'); await o.click('#aw-go'); await toastHas(o, /Cancelled/);
  ok(T.money_txns.get(pay.id).status === 'cancelled' && T.sales_docs.get(inv.id).paid === 0, 'payment cancelled: the bill is unpaid again');
  ok(/₹97,000/.test(await o.textContent('#tab-money .bank')), 'and HDFC is back to ₹97,000 (1,00,000 − 3,000)');
  ok([...T.sales_log.values()].some(l => /Cancelled in IN-231: cheque bounced/.test(l.what)), 'the cancel is in Activity with its reason');

  // the manager can work here; the supervisor cannot open it
  const m = await as(MGR); await m.goto(B + '/sales.html?tab=bills'); await m.waitForSelector('#bq');
  ok(/MF\/SL\/26-27\/157/.test(await m.textContent('#tab-bills')), 'the manager sees the bills');
  const s = await as(SUP); await s.goto(B + '/sales.html'); await s.waitForURL('**/board.html**', { timeout: 8000 }).catch(() => {});
  ok(/board\.html/.test(s.url()), 'the supervisor is sent back to the board');

  // ── link parties to board clients (043): deliveries open when the client's bills are 90 % paid ──
  { const sp = [...T.parties.values()].find(p => p.name === 'Mr Sharma'); sp.wedding_key = null; sp.phone = '98765 43210'; }   // as if moved from myBillBook: not linked
  await o.goto(B + '/sales.html?tab=parties&link=1'); await o.waitForSelector('#lk-list');
  const lk = await o.textContent('#lk-list');
  ok(/Sharma/.test(lk) && /Mr Sharma/.test(lk) && /of ₹/.test(lk), 'Link to board clients: Sharma (not linked) with "Mr Sharma" suggested by name, with what its bills say');
  await o.click('#lk-list [data-lk]'); await toastHas(o, /Linked Mr Sharma/);
  ok([...T.parties.values()].find(p => p.name === 'Mr Sharma').wedding_key === 'w:sharma', 'one tap links the party to the client');
  await o.click('[data-lv="done"]'); await o.waitForSelector('#lk-list [data-unlk]');
  ok(/Mr Sharma/.test(await o.textContent('#lk-list')) && /paid/.test(await o.textContent('#lk-list')), 'Linked shows the client with its party and how much of its bills is paid');
  await o.click('#lk-done');

  const ph = await as(OWNER, { width: 390, height: 844 }); await ph.goto(B + '/sales.html'); await ph.waitForSelector('#h-collect');
  ok(await ph.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: the Sales desk is not wider than the screen');
  await ph.click('#tab-home [data-new="quotation"]'); await ph.waitForSelector('#de-party');
  ok(await ph.evaluate(() => document.querySelector('.sheet').scrollWidth <= document.querySelector('.sheet').clientWidth + 1), 'phone: the quotation editor fits the screen');
  await sleep(600); await shot(ph, 'sales-editor-phone.png');

  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
