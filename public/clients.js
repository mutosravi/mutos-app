// Muto's app, owner and managers: the Clients window. One secret link per wedding; the family fills each function's
// time, venue, address, contact and notes (public/client.html). The board keeps their function list up to date (client_feed).
(function () {
  const app = window.mutosApp;
  let api = null, links = [], itin = [], applied = [], lastSig = new Map(), bookings = [], payments = [], packages = [], claims = [], dels = [];
  const sup = () => window.__mutosRole === 'supervisor'; // supervisor: Gmails, WhatsApp, answers, editing the form; no money
  const inr = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
  const KIND_LABELS = [['reel', 'Reel'], ['teaser', 'Teaser'], ['trailer', 'Trailer'], ['highlight', 'Highlight film'], ['full', 'Full film'], ['top', 'Top selection'], ['lr', 'LR edit'], ['album_sel', 'Album selection'], ['album', 'Album design'], ['other', 'Other']];
  const kindLabel = k => (KIND_LABELS.find(x => x[0] === k) || [k, k])[1];
  const itemText = it => kindLabel(it.kind) + (it.per === 'function' ? ' (each function)' : '') + (it.qty ? ' · ' + it.qty : '') + (it.note ? ' · ' + it.note : '');
  // same sums as booking_summary() in 009_bookings.sql
  function money(key) {
    const b = bookings.find(x => x.wedding_key === key); if (!b) return null;
    const t = todayIST(), paid = payments.filter(p => p.wedding_key === key).reduce((s2, p) => s2 + Number(p.amount), 0);
    const plan = (b.plan || []).slice().sort((x, y) => String(x.due).localeCompare(String(y.due)));
    const lateBy = plan.filter(x => addDaysStr(x.due, b.grace_days) < t).reduce((s2, x) => s2 + Number(x.amount), 0);
    let upto = 0, next = null; for (const x of plan) { upto += Number(x.amount); if (upto > paid) { next = x; break; } }
    const overdue = Math.max(0, lateBy - paid);
    return { b, paid, pending: Math.max(0, Number(b.total) - paid), overdue, next, soon: next && next.due >= t && next.due <= addDaysStr(t, 7) };
  }
  const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const addDaysStr = (d, n) => { const x = new Date(String(d) + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + Number(n || 0)); return x.toISOString().slice(0, 10); };
  const esc = s => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const digits = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1); return d; };
  const linkOf = () => location.origin + '/client';
  const previewOf = l => location.origin + '/client.html?k=' + l.token;
  const okMail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  const parseMails = t => [...new Set(String(t || '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(Boolean))];
  const dayName = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '';

  // weddings on the board: shoots grouped by the client (wedding name, else phone, else shoot name)
  function weddings(all) {
    const st = api.state(), today = api.todayStr(), by = new Map();
    st.events.forEach(ev => {
      if (!api.isActive(ev) || !ev.date) return;
      const key = ev.wedding ? 'w:' + api.normalizeName(ev.wedding) : ev.contactPhone ? 'p:' + digits(ev.contactPhone) : 'n:' + api.normalizeName(ev.name);
      if (!by.has(key)) by.set(key, { key, title: ev.wedding || ev.contactName || ev.name, phone: '', events: [] });
      const w = by.get(key); w.events.push(ev); if (!w.phone && ev.contactPhone) w.phone = ev.contactPhone; if (!w.occasion && ev.occasion) w.occasion = ev.occasion;
    });
    return [...by.values()].map(w => { w.events.sort((a, b) => a.date.localeCompare(b.date)); w.first = w.events[0].date; w.last = w.events[w.events.length - 1].date; return w; })
      .filter(w => all || w.last >= today).sort((a, b) => all ? b.first.localeCompare(a.first) : a.first.localeCompare(b.first));
  }
  // kind of client (17 Nov 2026): wedding (default) / anniversary / birthday / event / other, kept on the board's shoots
  const OCC = { wedding: ['Wedding', '💍'], anniversary: ['Anniversary', '💞'], birthday: ['Birthday', '🎂'], event: ['Event', '🎉'], other: ['Other', '📷'] };
  const occTag = w => { const o = OCC[w.occasion] || OCC.wedding; return '<span class="pill cl-occ" style="font-size:10.5px;margin-left:6px;vertical-align:2px">' + o[1] + ' ' + o[0] + '</span>'; };
  const feedOf = w => ({ functions: w.events.map(ev => ({ id: ev.id, name: ev.name, date: ev.date, slot: ev.slot, venue: ev.location || '', type: ev.eventType === 'full' ? 'full' : 'short', occasion: OCC[ev.occasion] ? ev.occasion : 'wedding' })) });

  async function load() {
    const c = await app.client();
    const [l, i] = await Promise.all([c.from('client_links').select('*'), c.from('client_itinerary').select('*')]);
    if (l.error) throw l.error;
    links = l.data || []; itin = i.error ? [] : (i.data || []);
    // what the database put on the board when a family pressed Send (017_client_auto_apply.sql); fine if not set up yet
    try { const g = await c.from('client_apply_log').select('wedding_key, event_id, at, before, after').order('at', { ascending: false }).limit(500); applied = g.error ? [] : (g.data || []); } catch (e) { applied = []; }
    // packages and payments (009_bookings.sql); fine if not set up yet
    const [b, p, k] = await Promise.all([c.from('bookings').select('*'), c.from('booking_payments').select('*').order('paid_on'), c.from('packages').select('*').order('name')]);
    bookings = b.error ? [] : (b.data || []); payments = p.error ? [] : (p.data || []); packages = k.error ? [] : (k.data || []);
    // after the shoot (035_after_shoot.sql): payments the families reported, services to deliver; fine if not set up yet
    if (!sup()) { try { const [x, d] = await Promise.all([c.from('client_pay_claims').select('*').order('at', { ascending: false }).limit(1000), c.from('client_deliveries').select('*').order('sort').limit(1000)]);
      claims = x.error ? [] : (x.data || []); dels = d.error ? [] : (d.data || []); } catch (e) { claims = []; dels = []; } }
  }
  // keep each linked wedding's function list fresh for the family
  async function sync() {
    if (!api) return;
    try {
      if (!links.length) await load();
      const c = await app.client(), ws = new Map(weddings().map(w => [w.key, w]));
      for (const l of links) {
        const w = ws.get(l.wedding_key); if (!w || !l.active) continue;
        const data = feedOf(w), sig = JSON.stringify(data);
        if (lastSig.get(l.wedding_key) === sig) continue;
        const { error } = await c.from('client_feed').upsert({ wedding_key: l.wedding_key, data });
        if (!error) lastSig.set(l.wedding_key, sig);
      }
    } catch (e) { console.warn('client feed', e); }
  }
  const filledN = (w, it) => { const a = (it && it.data) || {}; return w.events.filter(ev => a[ev.id] && a[ev.id].time && a[ev.id].venue && a[ev.id].address).length; };
  function stateOf(w) {
    const l = links.find(x => x.wedding_key === w.key), it = itin.find(x => x.wedding_key === w.key);
    if (!l) return { l, it, label: 'No link yet', cls: 'mute' };
    if (!it || !it.updated_at) return { l, it, label: 'Link made, not filled', cls: 'wait' };
    const n = filledN(w, it), extra = ((it.data || {}).extra || []).length;
    const fresh = it.submitted_at && (!it.reviewed_at || it.updated_at > it.reviewed_at);
    return { l, it, fresh, label: (it.submitted_at ? (fresh ? (applied.some(g => g.wedding_key === w.key && g.at >= it.submitted_at) ? 'New answers · on the board' : 'New answers to check') : 'Checked') : 'Filling') + ' · ' + n + ' of ' + w.events.length + (extra ? ' · +' + extra + ' new function' + (extra > 1 ? 's' : '') : ''), cls: fresh ? 'wait' : it.submitted_at ? 'ok' : 'mute' };
  }
  function summary() {
    if (!api) return null; const ws = weddings(), keys = new Set(ws.map(w => w.key));
    const all = bookings.map(b => money(b.wedding_key)).filter(Boolean);
    return { payToCheck: claims.filter(x => x.status === 'pending').length, toCheck: ws.filter(w => stateOf(w).fresh).length, noLink: ws.filter(w => !stateOf(w).l).length, overdue: all.filter(m => m.overdue > 0).length, dueSoon: all.filter(m => m.soon && keys.has(m.b.wedding_key)).length };
  }

  // shoots of the same family left out of a wedding (12 Nov 2026, Ravi: "I filled the Gmail … but it only shows in a single
  // function"): a wedding is the shoots with the same Wedding name; shoots with the same phone but no / another wedding name are
  // a different "client" for the app, so the family does not see them. Shown on the wedding with "Join them".
  function strays(w) {
    const ph = new Set(w.events.map(e => digits(e.contactPhone)).filter(x => x.length >= 10)); if (!ph.size) return [];
    const mine = new Set(w.events.map(e => e.id)), today = api.todayStr();
    return api.state().events.filter(e => api.isActive(e) && e.date && e.date >= today && !mine.has(e.id) && ph.has(digits(e.contactPhone)));
  }
  let clientsTab = 'coming';
  // sort clients (20 Nov 2026, Ravi: "An option needed to sort client name by date, alphabet, etc."); remembered on this device
  const SORTS = [['date', 'Date'], ['dater', 'Date, other way'], ['az', 'Name A–Z'], ['za', 'Name Z–A'], ['kind', 'Kind of client'], ['fns', 'Most functions']];
  const getSort = k => { try { return localStorage.getItem('mutos-sort-' + k) || 'date'; } catch (e) { return 'date'; } };
  const setSort = (k, v) => { try { localStorage.setItem('mutos-sort-' + k, v); } catch (e) {} };
  // date: coming = soonest first; past / all = most recent first
  function sortWs(list, mode, newestFirst) {
    const name = w => String(w.title || '').toLowerCase(), byDate = (a, b) => newestFirst ? String(b.last).localeCompare(String(a.last)) : String(a.first).localeCompare(String(b.first));
    const f = { date: byDate, dater: (a, b) => -byDate(a, b), az: (a, b) => name(a).localeCompare(name(b)), za: (a, b) => name(b).localeCompare(name(a)),
      kind: (a, b) => String(a.occasion || 'wedding').localeCompare(String(b.occasion || 'wedding')) || byDate(a, b), fns: (a, b) => b.events.length - a.events.length || byDate(a, b) }[mode] || byDate;
    return list.slice().sort(f);
  }
  const sortSel = (id, v) => '<select class="sb-field" id="' + id + '" aria-label="Sort" style="flex:0 0 auto;max-width:170px">' + SORTS.map(([k, l]) => '<option value="' + k + '"' + (k === v ? ' selected' : '') + '>Sort: ' + esc(l) + '</option>').join('') + '</select>';
  async function open() {
    if (!api) { alert('The board is still loading.'); return; }
    try { await load(); } catch (e) { api.toast('Could not load clients: ' + (e.message || e) + '. Run supabase/004_studio.sql first.'); return; }
    sync();
    // Coming up | Past (12 Nov 2026, Ravi: "what about clients? I need to see data copied"): past weddings with Data, History and payments
    const today = api.todayStr(), past = clientsTab === 'past';
    const sortMode = getSort('clients');
    const ws = sortWs(past ? weddings(true).filter(w => w.last < today) : weddings(), sortMode, past);
    const tabs = '<div class="sb-btn-row" id="cl-tabs" style="padding:0 8px 6px"><button type="button" class="sb-btn-sm' + (past ? ' secondary' : '') + '" data-cltab="coming">Coming up</button><button type="button" class="sb-btn-sm' + (past ? '' : ' secondary') + '" data-cltab="past">Past</button>' +
      '<input class="sb-field" id="cl-q" placeholder="' + (past ? 'Search a past client' : 'Search a client') + '" style="flex:1 1 160px;min-width:0">' + sortSel('cl-sort', sortMode) + '</div>';
    const pastRow = w => '<div class="sb-manage-row cl-past cl-row" data-q="' + esc((w.title + ' ' + w.events.map(e => e.name).join(' ')).toLowerCase()) + '" style="display:block;padding:10px 8px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><b style="font-size:14px">' + esc(w.title) + '</b>' + occTag(w) + '<br><span class="sb-manage-sub">' + esc(dayName(w.first) + (w.last !== w.first ? ' – ' + dayName(w.last) : '') + ' · ' + w.events.length + ' function' + (w.events.length > 1 ? 's' : '')) + '</span></div>' + moneyPill(w.key) + '</div>' +
      '<div class="sb-btn-row" style="margin-top:8px"><button type="button" class="sb-btn-sm" data-data="' + esc(w.key) + '">Data copied</button>' + (sup() ? '' : '<button type="button" class="sb-btn-sm secondary" data-ren="' + esc(w.key) + '">Rename</button><button type="button" class="sb-btn-sm secondary" data-hist="' + esc(w.key) + '">History</button><button type="button" class="sb-btn-sm secondary" data-book="' + esc(w.key) + '">' + (bookings.some(b => b.wedding_key === w.key) ? 'Package & payments' : 'Add package') + '</button><button type="button" class="sb-btn-sm secondary" data-after="' + esc(w.key) + '">After shoot' + (claims.some(x => x.wedding_key === w.key && x.status === 'pending') ? ' · ₹ to check' : '') + '</button>') + '</div></div>';
    const html = tabs + '<div class="sb-modal-list" id="cl-list">' + (past ? (ws.length ? ws.map(pastRow).join('') : '<p class="sb-modal-empty">No past clients on the board.</p>') : ws.length ? ws.map(w => {
      const s = stateOf(w), sx = strays(w);
      return '<div class="sb-manage-row cl-row" data-q="' + esc((w.title + ' ' + w.events.map(e => e.name).join(' ')).toLowerCase()) + '" style="display:block;padding:10px 8px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><b style="font-size:14px">' + esc(w.title) + '</b>' + occTag(w) + '<br><span class="sb-manage-sub">' + esc(dayName(w.first) + (w.last !== w.first ? ' – ' + dayName(w.last) : '') + ' · ' + w.events.length + ' function' + (w.events.length > 1 ? 's' : '') + (w.phone ? ' · ' + w.phone : '')) + '</span>' +
        (sx.length ? '<div class="cl-stray" style="margin-top:6px;background:#f2dfa7;color:#5c4410;border-radius:10px;padding:6px 8px;font-size:12.5px;line-height:1.4">Same phone, but not under this client (the family will not see them): <b>' + esc(sx.map(e => e.name + ' (' + dayName(e.date) + ')').join(', ')) + '</b>' +
          (w.key.startsWith('w:') && !sup() ? ' <button type="button" class="sb-btn-sm" data-join="' + esc(w.key) + '" style="margin-left:4px">Join them</button>' : '') + '</div>' : '') + '</div>' +
        '<span style="display:flex;flex-direction:column;gap:4px;align-items:flex-end"><span class="pill ' + s.cls + '" style="font-size:11px;white-space:nowrap">' + esc(s.label) + '</span>' + moneyPill(w.key) + '</span></div><div class="sb-btn-row" style="margin-top:8px"><button type="button" class="sb-btn-sm secondary" data-data="' + esc(w.key) + '">Data</button>' + (sup() ? '' : '<button type="button" class="sb-btn-sm secondary" data-ren="' + esc(w.key) + '">Rename</button><button type="button" class="sb-btn-sm secondary" data-hist="' + esc(w.key) + '">History</button>') + '<button type="button" class="sb-btn-sm secondary" data-book="' + esc(w.key) + '">' + (bookings.some(b => b.wedding_key === w.key) ? 'Package & payments' : 'Add package') + '</button><button type="button" class="sb-btn-sm secondary" data-after="' + esc(w.key) + '">After shoot' + (claims.some(x => x.wedding_key === w.key && x.status === 'pending') ? ' · ₹ to check' : '') + '</button>' +
        (s.l ? (s.l.emails && s.l.emails.length ? '<a class="sb-btn-sm wa" data-wa="' + esc(w.key) + '" href="#">WhatsApp</a>' : '') + '<button type="button" class="sb-btn-sm secondary" data-mails="' + esc(w.key) + '">Gmails (' + ((s.l.emails || []).length) + ')</button><a class="sb-btn-sm secondary" href="' + esc(previewOf(s.l)) + '" target="_blank" rel="noopener">Open &amp; edit</a>' + (s.it && s.it.updated_at ? '<button type="button" class="sb-btn-sm" data-see="' + esc(w.key) + '">See answers</button>' : '')
          : '<button type="button" class="sb-btn-sm" data-make="' + esc(w.key) + '">Add client Gmail</button>') + '</div>' +
        (s.l && !(s.l.emails || []).length ? '<div class="sb-manage-sub" style="color:#7a2d1e;margin-top:4px">No Gmail yet: the family cannot sign in. Tap Gmails.</div>' : s.l ? '<div class="sb-manage-sub" style="margin-top:4px">Signs in with: ' + esc(s.l.emails.join(', ')) + '</div>' : '') + '</div>';
    }).join('') : '<p class="sb-modal-empty">No upcoming clients on the board. Past ones are under Past.</p>') + '</div>';
    const modal = api.makeModal(api.modalHead('Clients', 'Add the family\'s Gmail(s) to a client (wedding, birthday, anniversary, event…). They sign in at ' + location.host + '/client with that Gmail and fill time, venue, address and contact for every function. Nobody else can open it.') + html + '<div class="sb-modal-foot"><button type="button" class="secondary" id="cl-find">Find client data</button><button type="button" class="secondary" id="cl-joinsel">Join shoots into one client</button><button type="button" class="secondary" id="cl-packages">Packages</button><button type="button" id="cl-done">Done</button></div>', true);
    modal.querySelector('#cl-done').addEventListener('click', api.closeModal);
    modal.querySelectorAll('[data-join]').forEach(b => b.addEventListener('click', () => {
      const w = ws.find(x => x.key === b.dataset.join), name = w.events[0].wedding, sx = strays(w); if (!w || !name || !sx.length) return;
      if (!confirm('Put ' + sx.map(e => e.name).join(', ') + ' into the wedding "' + name + '"? The family will then see ' + (sx.length > 1 ? 'them' : 'it') + ' on their page too.')) return;
      sx.forEach(e => { e.wedding = name; }); api.save(); if (window.MUTOS_APP && window.MUTOS_APP.changed) window.MUTOS_APP.changed(); api.renderBoard();
      api.toast(sx.length + ' function' + (sx.length > 1 ? 's' : '') + ' joined to ' + name + '.'); open();
    }));
    modal.querySelectorAll('[data-cltab]').forEach(b => b.addEventListener('click', () => { clientsTab = b.dataset.cltab; open(); }));
    { const qi = modal.querySelector('#cl-q'); if (qi) qi.addEventListener('input', () => { const v = qi.value.trim().toLowerCase(); modal.querySelectorAll('.cl-row').forEach(r => { r.style.display = !v || r.dataset.q.includes(v) ? 'block' : 'none'; }); }); }
    modal.querySelector('#cl-sort').addEventListener('change', e => { setSort('clients', e.target.value); open(); });
    const byKey = k => ws.find(w => w.key === k);
    modal.querySelectorAll('[data-make], [data-mails]').forEach(b => b.addEventListener('click', () => gmails(byKey(b.dataset.make || b.dataset.mails))));
    modal.querySelectorAll('[data-wa]').forEach(a => {
      const w = byKey(a.dataset.wa), l = links.find(x => x.wedding_key === w.key);
      const msg = 'Namaste! This is Muto\'s. For ' + w.title + ', please fill in the details of each function (start time, venue, address and a contact person at the venue) so our team reaches on time.\n\nOpen ' + linkOf() + ' and sign in with ' + l.emails.join(' or ') + '\n\nIt takes about 5 minutes and you can change it any time. Thank you!';
      a.href = 'https://wa.me/' + (digits(w.phone) || '') + '?text=' + encodeURIComponent(msg); a.target = '_blank'; a.rel = 'noopener';
    });
    modal.querySelectorAll('[data-see]').forEach(b => b.addEventListener('click', () => answers(byKey(b.dataset.see))));
    modal.querySelectorAll('[data-book]').forEach(b => b.addEventListener('click', () => booking(byKey(b.dataset.book))));
    modal.querySelectorAll('[data-after]').forEach(b => b.addEventListener('click', () => afterWin(byKey(b.dataset.after))));
    modal.querySelectorAll('[data-data]').forEach(b => b.addEventListener('click', () => dataWin(byKey(b.dataset.data), open)));
    modal.querySelectorAll('[data-hist]').forEach(b => b.addEventListener('click', () => histWin(byKey(b.dataset.hist), open)));
    modal.querySelectorAll('[data-ren]').forEach(b => b.addEventListener('click', () => renameWin(b.dataset.ren)));
    modal.querySelector('#cl-find').addEventListener('click', () => findData(open));
    { const j = modal.querySelector('#cl-joinsel'); if (sup()) j.remove(); else j.addEventListener('click', () => joinWin()); }
    const pk = modal.querySelector('#cl-packages'); if (pk) pk.addEventListener('click', () => packagesWin());
    if (sup()) modal.querySelectorAll('[data-book], [data-after], #cl-packages').forEach(x => x.remove());
  }
  // ---------- after the shoot (23 Nov 2026, Ravi; 035_after_shoot.sql) ----------
  // Services to deliver (ticked from the package items, or typed) with status + link; the family sees the status any time and the
  // links once approved payments reach 90 % of the package (or when opened by hand). Payments the family reports wait here for the
  // admin / manager: Approve (it becomes a payment in Package & payments) or Not received (with a reason the family sees).
  const DSTAT = [['waiting', 'Not started'], ['editing', 'Editing'], ['ready', 'Ready'], ['delivered', 'Delivered']];
  const claimRow = (x, withName) => '<div class="sb-manage-row af-claim" data-claim="' + esc(x.id) + '" style="display:block;padding:9px 8px">' +
    (withName ? '<b>' + esc((links.find(l => l.wedding_key === x.wedding_key) || {}).title || x.wedding_key.replace(/^w:/, '')) + '</b><br>' : '') +
    '<b>' + inr(x.amount) + '</b> · ' + esc(x.mode) + ' · paid ' + esc(dayName(x.paid_on)) + (x.upi_ref ? ' · ref ' + esc(x.upi_ref) : '') + (x.note ? '<br><span class="sb-manage-sub">' + esc(x.note) + '</span>' : '') +
    '<br><span class="sb-manage-sub">Reported by ' + esc(x.by_email) + ' · ' + esc(new Date(x.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })) + '</span>' +
    (x.status === 'pending' ? '<div class="sb-btn-row" style="margin-top:6px;align-items:center">' + (x.photo ? '<button type="button" class="sb-btn-sm secondary" data-cph="' + esc(x.photo) + '">See screenshot</button>' : '<span class="sb-manage-sub">No screenshot</span>') +
      '<input class="sb-field" type="number" min="1" step="1" data-camt="' + esc(x.id) + '" value="' + esc(String(Math.round(x.amount))) + '" style="width:110px" aria-label="Amount received">' +
      '<button type="button" class="sb-btn-sm" data-cok="' + esc(x.id) + '">Approve</button><button type="button" class="sb-btn-sm secondary" data-cno="' + esc(x.id) + '">Not received</button></div>'
      : '<br><span class="pill ' + (x.status === 'approved' ? 'ok' : 'no') + '" style="font-size:11px">' + (x.status === 'approved' ? 'Approved' : 'Not received') + '</span>' + (x.why ? ' <span class="sb-manage-sub" style="display:inline">' + esc(x.why) + '</span>' : '') + (x.photo ? ' <button type="button" class="sb-btn-sm secondary" data-cph="' + esc(x.photo) + '">Screenshot</button>' : '')) + '</div>';
  function wireClaims(modal, after) {
    modal.querySelectorAll('[data-cph]').forEach(b => b.addEventListener('click', () => { if (window.MutosPhotos) app.client().then(c => window.MutosPhotos.view(c, [{ pid: b.dataset.cph, title: 'Payment screenshot', sub: '' }], 0)); else api.toast('Photos are not set up here.'); }));
    const decide = async (id, ok) => {
      const why = ok ? '' : prompt('Why is it not received? The family sees this.', 'Not received in our account yet'); if (!ok && !why) return;
      const amtEl = modal.querySelector('[data-camt="' + id + '"]'), amt = amtEl ? Number(amtEl.value) : null;
      const c = await app.client(), { data, error } = await c.rpc('client_pay_decide', { p_claim: id, p_approve: ok, p_why: why || null, p_amount: ok && amt > 0 ? amt : null });
      if (error || !data || data.error) { api.toast(error ? error.message : data.error); return; }
      api.toast(ok ? 'Approved: added to Package & payments.' + (data.open ? ' Deliveries are open for the family.' : '') : 'Marked not received. The family sees why.');
      await load(); after();
    };
    modal.querySelectorAll('[data-cok]').forEach(b => b.addEventListener('click', () => decide(b.dataset.cok, true)));
    modal.querySelectorAll('[data-cno]').forEach(b => b.addEventListener('click', () => decide(b.dataset.cno, false)));
  }
  async function afterWin(w) {
    if (!w || sup()) return;
    try { await load(); } catch (e) { api.toast('Could not load: ' + (e.message || e)); return; }
    const m = money(w.key), l = links.find(x => x.wedding_key === w.key), bk = bookings.find(b => b.wedding_key === w.key);
    const total = m ? Number(m.b.total) : 0, paid = m ? m.paid : 0, need = total > 0 ? Math.max(0, Math.ceil(total * 0.9) - paid) : null;
    const hand = l ? l.deliveries_open : null, auto = total > 0 && paid >= total * 0.9, isOpen = hand === true || (hand !== false && auto);
    const mine = dels.filter(d => d.wedding_key === w.key), cl = claims.filter(x => x.wedding_key === w.key);
    // services: what is already listed, then the package items not listed yet (unticked)
    const fromPkg = ((bk && bk.items) || []).map(it => ({ kind: it.kind, title: (kindLabel(it.kind) + (it.per === 'function' ? ' (each function)' : '') + (it.note ? ' · ' + it.note : '')).slice(0, 80) }));
    const rows = mine.map(d => ({ id: d.id, on: true, kind: d.kind, title: d.title, status: d.status, link: d.link || '', note: d.note || '' }))
      .concat(fromPkg.filter(f => !mine.some(d => d.title === f.title)).map(f => ({ on: false, kind: f.kind, title: f.title, status: 'waiting', link: '', note: '' })));
    const svc = (r, i) => '<div class="sb-manage-row af-svc" data-i="' + i + '" style="display:block;padding:8px">' +
      '<label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" class="af-on" ' + (r.on ? 'checked' : '') + ' style="width:18px;height:18px"><b>' + esc(r.title) + '</b></label>' +
      '<div class="af-more" style="display:' + (r.on ? 'grid' : 'none') + ';grid-template-columns:auto 1fr;gap:6px;margin-top:6px"><select class="sb-field af-st">' + DSTAT.map(([k, t]) => '<option value="' + k + '"' + (r.status === k ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>' +
      '<input class="sb-field af-link" type="url" placeholder="Link (Drive, gallery…) when ready" value="' + esc(r.link) + '" data-nosuggest>' +
      '<input class="sb-field af-note" placeholder="Note for the family (optional)" maxlength="300" value="' + esc(r.note) + '" style="grid-column:1/-1" data-nosuggest></div></div>';
    const pend = cl.filter(x => x.status === 'pending'), done = cl.filter(x => x.status !== 'pending');
    const rule = '<div class="sb-btn-row" id="af-rule" style="margin:6px 0 0">' + [['auto', 'By payment (90%)'], ['open', 'Open now'], ['closed', 'Keep closed']].map(([k, t]) =>
      '<button type="button" class="sb-btn-sm' + ((k === 'auto' && hand == null) || (k === 'open' && hand === true) || (k === 'closed' && hand === false) ? '' : ' secondary') + '" data-rule="' + k + '">' + t + '</button>').join('') + '</div>';
    const modal = api.makeModal(api.modalHead('After shoot · ' + w.title, 'Tick what you deliver. The family sees the status any time; the links open when approved payments reach 90% of the package, or when you open them by hand.') +
      '<div class="sb-modal-list" id="af-list">' +
      '<div class="sb-manage-sub" id="af-state" style="margin:4px 8px 8px;padding:8px 10px;border-radius:10px;background:' + (isOpen ? '#e1efe4' : '#f7e9d0') + ';color:var(--ink)">' +
        (total > 0 ? 'Paid <b>' + inr(paid) + '</b> of ' + inr(total) + ' (' + Math.floor(paid / total * 100) + '%). ' : 'No package yet: add it in Package & payments. ') +
        (isOpen ? '<b>Deliveries are open</b> for the family' + (hand === true ? ' (opened by hand)' : '') + '.' : '<b>Deliveries are closed</b>' + (hand === false ? ' (kept closed by hand)' : need != null ? ': ' + inr(need) + ' more opens them.' : '.')) +
        (l ? rule : '<br>Add the family\'s Gmail first: then they can see this on their page.') + '</div>' +
      '<p class="sb-modal-group">Payments the family reported' + (pend.length ? ' · ' + pend.length + ' to check' : '') + '</p>' +
        (cl.length ? pend.map(x => claimRow(x)).join('') + done.slice(0, 10).map(x => claimRow(x)).join('') : '<p class="sb-modal-empty">None yet. The family taps "We paid" on their page.</p>') +
      '<p class="sb-modal-group">Services to deliver</p><div id="af-svcs">' + (rows.length ? rows.map(svc).join('') : '<p class="sb-modal-empty">No package items. Add a service below.</p>') + '</div>' +
      '<div class="sb-btn-row" style="padding:4px 8px"><input class="sb-field" id="af-new" placeholder="Another service, e.g. Pendrive" maxlength="80" style="flex:1 1 160px" data-nosuggest><button type="button" class="sb-btn-sm secondary" id="af-add">＋ Add</button></div>' +
      '</div><div class="sb-modal-foot"><button type="button" class="secondary" id="af-back">Back</button>' + (l && (l.emails || []).length ? '<a class="sb-btn-sm wa" id="af-wa" href="#" style="align-self:center">WhatsApp</a>' : '') + '<button type="button" id="af-save">Save</button></div>', true);
    const q = x => modal.querySelector(x);
    modal.querySelectorAll('.af-on').forEach(cb => cb.addEventListener('change', () => { cb.closest('.af-svc').querySelector('.af-more').style.display = cb.checked ? 'grid' : 'none'; }));
    q('#af-add').addEventListener('click', () => { const t = q('#af-new').value.trim(); if (!t) return; rows.push({ on: true, kind: null, title: t.slice(0, 80), status: 'waiting', link: '', note: '' }); q('#af-svcs').insertAdjacentHTML('beforeend', svc(rows[rows.length - 1], rows.length - 1)); const cb = q('#af-svcs .af-svc:last-child .af-on'); cb.addEventListener('change', () => { cb.closest('.af-svc').querySelector('.af-more').style.display = cb.checked ? 'grid' : 'none'; }); q('#af-new').value = ''; const em = q('#af-svcs .sb-modal-empty'); if (em) em.remove(); });
    q('#af-back').addEventListener('click', open);
    modal.querySelectorAll('[data-rule]').forEach(b => b.addEventListener('click', async () => {
      const v = { auto: null, open: true, closed: false }[b.dataset.rule], c = await app.client();
      const { data, error } = await c.rpc('client_deliveries_set_open', { p_key: w.key, p_open: v });
      if (error || !data || data.error) { api.toast(error ? (/client_deliveries_set_open/.test(error.message) ? 'Run supabase/035_after_shoot.sql first.' : error.message) : data.error); return; }
      api.toast(data.open ? 'Deliveries are open for the family.' : 'Deliveries are closed for the family.'); afterWin(w);
    }));
    wireClaims(modal, () => afterWin(w));
    const wa = q('#af-wa'); if (wa) {
      const ready = mine.filter(d => d.status === 'ready' || d.status === 'delivered').map(d => d.title);
      const msg = 'Namaste! This is Muto\'s. ' + (ready.length ? 'Ready for ' + w.title + ': ' + ready.join(', ') + '. ' : 'Updates for ' + w.title + ' are on your page. ') +
        (isOpen ? 'Open ' + linkOf() + ' and sign in with ' + l.emails.join(' or ') + ' to see and download them.' : 'They open on your page at ' + linkOf() + ' once ' + (need != null ? inr(need) + ' more is paid' : 'the payment is done') + '. You can tell us there when you pay.') + ' Thank you!';
      wa.href = 'https://wa.me/' + (digits(w.phone) || '') + '?text=' + encodeURIComponent(msg); wa.target = '_blank'; wa.rel = 'noopener';
    }
    q('#af-save').addEventListener('click', async () => {
      const c = await app.client(), btn = q('#af-save'); btn.disabled = true; btn.textContent = 'Saving…';
      const errs = [];
      const els = [...modal.querySelectorAll('.af-svc')];
      for (const [n, el] of els.entries()) {
        const r = rows[+el.dataset.i], on = el.querySelector('.af-on').checked, link = el.querySelector('.af-link').value.trim();
        if (on && link && !/^https?:\/\//i.test(link)) { errs.push(r.title + ': the link must start with https://'); continue; }
        const row = { wedding_key: w.key, kind: r.kind || null, title: r.title, status: el.querySelector('.af-st').value, link: link || null, note: el.querySelector('.af-note').value.trim() || null, sort: n };
        const res = on ? (r.id ? await c.from('client_deliveries').update(row).eq('id', r.id) : await c.from('client_deliveries').insert(row)) : r.id ? await c.from('client_deliveries').delete().eq('id', r.id) : { error: null };
        if (res.error) errs.push(r.title + ': ' + (/client_deliveries/.test(res.error.message) ? 'run supabase/035_after_shoot.sql first' : res.error.message));
      }
      if (errs.length) { api.toast(errs[0]); btn.disabled = false; btn.textContent = 'Save'; return; }
      api.toast('Saved. The family sees it on their page.'); afterWin(w);
    });
  }
  // every payment the families reported and not checked yet (Home → Needs you → Payments to check)
  async function payWin() {
    if (!api || sup()) return;
    try { await load(); } catch (e) { api.toast('Could not load: ' + (e.message || e)); return; }
    const pend = claims.filter(x => x.status === 'pending');
    const modal = api.makeModal(api.modalHead('Payments to check', 'Families tapped "We paid". Check your account, then Approve (it goes into Package & payments) or Not received.') +
      '<div class="sb-modal-list" id="pay-list">' + (pend.length ? pend.map(x => claimRow(x, true) + '<div style="padding:0 8px 8px"><button type="button" class="sb-btn-sm secondary" data-paf="' + esc(x.wedding_key) + '">Open After shoot</button></div>').join('') : '<p class="sb-modal-empty">Nothing to check. 🎉</p>') + '</div>' +
      '<div class="sb-modal-foot"><button type="button" id="pay-done">Done</button></div>', true);
    modal.querySelector('#pay-done').addEventListener('click', api.closeModal);
    wireClaims(modal, payWin);
    modal.querySelectorAll('[data-paf]').forEach(b => b.addEventListener('click', () => afterWin(weddings(true).find(w => w.key === b.dataset.paf) || { key: b.dataset.paf, title: b.dataset.paf.replace(/^w:/, ''), events: [], phone: '' })));
  }

  // join shoots into one client (23 Nov 2026, Ravi: "a select option on client page which allows selecting further events where
  // clients' are not named or assigned and the events are split and let them give a client's name to make it one")
  // Tick the shoots, type (or pick) the client's name, Join: every ticked shoot gets that name (ev.wedding). A client whose shoots
  // ALL move and who already has a family login / form / package is renamed with 031 client_rename, so that stays with them.
  let joinShow = 'none';
  function joinWin(picked) {
    if (sup()) return;
    const today = api.todayStr(), from = addDaysStr(today, -60), sel = new Set(picked || []);
    const all = api.state().events.filter(e => api.isActive(e) && e.date && (joinShow === 'past' ? true : e.date >= from)).sort((a, b) => a.date.localeCompare(b.date) || String(a.slot).localeCompare(String(b.slot)));
    const keyOf = ev => ev.wedding ? 'w:' + api.normalizeName(ev.wedding) : ev.contactPhone ? 'p:' + digits(ev.contactPhone) : 'n:' + api.normalizeName(ev.name);
    const ws = weddings(true), wOf = new Map(); ws.forEach(w => w.events.forEach(e => wOf.set(e.id, w)));
    const list = all.filter(e => joinShow !== 'none' || !e.wedding || sel.has(e.id));
    const names = [...new Set(ws.filter(w => w.key.startsWith('w:')).map(w => w.events.find(e => e.wedding).wedding))].sort((a, b) => a.localeCompare(b));
    const chip = (k, l) => '<button type="button" class="sb-btn-sm' + (joinShow === k ? '' : ' secondary') + '" data-jshow="' + k + '">' + esc(l) + '</button>';
    const row = e => { const w = wOf.get(e.id), who = e.wedding ? e.wedding : 'No client name' + (e.contactName ? ' · ' + e.contactName : '');
      return '<label class="sb-manage-row jn-row" data-q="' + esc((e.name + ' ' + (e.wedding || '') + ' ' + (e.contactName || '') + ' ' + (e.contactPhone || '') + ' ' + (e.location || '')).toLowerCase()) + '" style="display:flex;gap:10px;align-items:flex-start;padding:9px 8px;cursor:pointer">' +
        '<input type="checkbox" class="jn-pick" value="' + esc(e.id) + '"' + (sel.has(e.id) ? ' checked' : '') + ' style="margin-top:3px;width:18px;height:18px;flex:0 0 auto">' +
        '<span style="min-width:0"><b>' + esc(e.name) + '</b> <span class="sb-manage-sub" style="display:inline">' + esc(dayName(e.date) + ' · ' + e.slot) + '</span><br>' +
        '<span class="sb-manage-sub"' + (e.wedding ? '' : ' style="color:#7a2d1e"') + '>' + esc(who + (w && w.events.length > 1 ? ' (' + w.events.length + ' shoots)' : '') + (e.contactPhone ? ' · ' + e.contactPhone : '') + (e.location ? ' · ' + e.location : '')) + '</span></span></label>'; };
    const modal = api.makeModal(api.modalHead('Join shoots into one client', 'Tick the shoots of one client, give the client\'s name and press Join. The family then sees all of them on their page.') +
      '<div class="sb-btn-row" style="padding:0 8px 6px">' + chip('none', 'No client name') + chip('all', 'All shoots') + chip('past', 'Older too') +
      '<input class="sb-field" id="jn-q" type="search" placeholder="Search name, phone, venue" style="flex:1 1 160px;min-width:0" data-nosuggest></div>' +
      '<div class="sb-modal-list" id="jn-list">' + (list.length ? list.map(row).join('') : '<p class="sb-modal-empty">No shoots without a client name. Tap All shoots to see every shoot.</p>') + '</div>' +
      '<div class="sb-edit-form" style="border-top:1px solid var(--card-edge)"><label class="sb-edit-label" for="jn-name">Client name for the ticked shoots (<span id="jn-n">0</span>)</label>' +
      '<input id="jn-name" class="sb-field" maxlength="120" list="jn-names" placeholder="e.g. Sharma wedding"><datalist id="jn-names">' + names.map(n => '<option value="' + esc(n) + '">').join('') + '</datalist>' +
      '<p class="sb-manage-sub" id="jn-note" style="margin:6px 0 0"></p></div>' +
      '<div class="sb-modal-foot"><button type="button" class="secondary" id="jn-back">Back</button><button type="button" id="jn-go">Join</button></div>', true);
    const q = s2 => modal.querySelector(s2), picks = () => [...modal.querySelectorAll('.jn-pick:checked')].map(i => i.value);
    const note = () => {
      const ids = picks(), nm = q('#jn-name').value.trim(); q('#jn-n').textContent = ids.length;
      const evs = ids.map(id => all.find(e => e.id === id)).filter(Boolean), olds = [...new Set(evs.filter(e => e.wedding && e.wedding !== nm).map(e => e.wedding))];
      const ex = nm && ws.find(w => w.key === 'w:' + api.normalizeName(nm));
      q('#jn-note').textContent = (ex ? nm + ' already has ' + ex.events.length + ' shoot' + (ex.events.length > 1 ? 's' : '') + ': these join them. ' : '') + (olds.length ? 'Moves them out of: ' + olds.join(', ') + '.' : '');
      if (!nm && evs.length) { const g = evs.find(e => e.wedding); if (g) q('#jn-name').placeholder = g.wedding; }
    };
    modal.querySelectorAll('.jn-pick').forEach(i => i.addEventListener('change', note));
    q('#jn-name').addEventListener('input', note);
    modal.querySelectorAll('[data-jshow]').forEach(b => b.addEventListener('click', () => { joinShow = b.dataset.jshow; joinWin(picks()); }));
    q('#jn-q').addEventListener('input', () => { const v = q('#jn-q').value.trim().toLowerCase(); modal.querySelectorAll('.jn-row').forEach(r => { r.style.display = !v || r.dataset.q.includes(v) ? 'flex' : 'none'; }); });
    q('#jn-back').addEventListener('click', open);
    q('#jn-go').addEventListener('click', async () => {
      const ids = picks(); let name = q('#jn-name').value.trim().replace(/\s+/g, ' ');
      if (!name) { const g = ids.map(id => all.find(e => e.id === id)).find(e => e && e.wedding); if (g) name = g.wedding; }
      if (ids.length < 1) { api.toast('Tick the shoots first.'); return; }
      if (!name) { api.toast('Type the client\'s name.'); return; }
      const evs = ids.map(id => api.state().events.find(e => e.id === id)).filter(Boolean), nk = 'w:' + api.normalizeName(name);
      if (!confirm(evs.length + ' shoot' + (evs.length > 1 ? 's' : '') + ' become the client "' + name + '":\n' + evs.map(e => '· ' + e.name + ' (' + dayName(e.date) + ')').join('\n'))) return;
      const btn = q('#jn-go'); btn.disabled = true; btn.textContent = 'Joining…';
      try {
        const c = await app.client();
        // a client that moves whole and has a family login / form / package keeps them under the new name
        const groups = new Map(); evs.forEach(e => { const k = keyOf(e); if (k !== nk) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e); } });
        for (const [k, g] of groups) {
          const w = ws.find(x => x.key === k); if (!w || w.events.length !== g.length) continue;
          if (!links.some(l => l.wedding_key === k) && !itin.some(i => i.wedding_key === k) && !bookings.some(b => b.wedding_key === k)) continue;
          const { data, error } = await c.rpc('client_rename', { p_old: k, p_new: nk, p_title: name, p_events: g.map(e => e.id) });
          if (error || !data || data.error) { api.toast('Could not join ' + w.title + ': ' + (error ? error.message : data.error)); btn.disabled = false; btn.textContent = 'Join'; return; }
        }
        evs.forEach(e => { e.wedding = name; }); api.save(); if (window.MUTOS_APP && window.MUTOS_APP.changed) window.MUTOS_APP.changed(); api.renderBoard();
        lastSig.delete(nk); await load(); await sync();
        api.toast(evs.length + ' shoot' + (evs.length > 1 ? 's are' : ' is') + ' now under ' + name + '.'); open();
      } catch (e) { api.toast('Could not join: ' + (e.message || e)); btn.disabled = false; btn.textContent = 'Join'; }
    });
    note();
  }
  // rename a client (20 Nov 2026, Ravi): every shoot of the client gets the new name, and 031 client_rename moves what hangs on the
  // old name (family login and answers, package & payments, Work desk jobs, drive data, family photos) to the new one
  function renameWin(key) {
    const w = weddings(true).find(x => x.key === key); if (!w || sup()) return;
    const modal = api.makeModal(api.modalHead('Rename client', w.events.length + ' shoot' + (w.events.length > 1 ? 's' : '') + ' of ' + w.title + ' get the new name. The family login and answers, package & payments, Work desk jobs, drive data and family photos move with it.') +
      '<div class="sb-edit-form"><label class="sb-edit-label" for="rn-name">New name</label><input id="rn-name" class="sb-field" maxlength="120" data-nosuggest>' +
      '<p class="sb-manage-sub" id="rn-note" style="margin:6px 0 0"></p><p class="sb-manage-sub" style="margin:6px 0 0">' + esc(w.events.map(e => e.name + ' (' + dayName(e.date) + ')').join(' · ')) + '</p></div>' +
      '<div class="sb-modal-foot"><button type="button" class="secondary" id="rn-back">Back</button><button type="button" id="rn-go">Rename</button></div>', true);
    const inp = modal.querySelector('#rn-name'); inp.value = w.events.find(e => e.wedding) ? w.events.find(e => e.wedding).wedding : w.title; setTimeout(() => { inp.focus(); inp.select(); }, 30);
    const other = () => { const k = 'w:' + api.normalizeName(inp.value.trim()); return k !== w.key ? weddings(true).find(x => x.key === k) : null; };
    inp.addEventListener('input', () => { const o = other(); modal.querySelector('#rn-note').textContent = o ? 'There is already a client called ' + o.title + ' (' + o.events.length + ' shoot' + (o.events.length > 1 ? 's' : '') + '): the two become one client.' : ''; });
    modal.querySelector('#rn-back').addEventListener('click', open);
    modal.querySelector('#rn-go').addEventListener('click', async () => {
      const name = inp.value.trim().replace(/\s+/g, ' '); if (!name) { api.toast('Type the new name.'); return; }
      const nk = 'w:' + api.normalizeName(name), o = other();
      if (nk === w.key && w.events.every(e => e.wedding === name)) { open(); return; }
      if (o && !confirm(w.title + ' and ' + o.title + ' will be one client called ' + name + '. Go ahead?')) return;
      const btn = modal.querySelector('#rn-go'); btn.disabled = true; btn.textContent = 'Renaming…';
      try {
        if (nk !== w.key) {
          const c = await app.client(), { data, error } = await c.rpc('client_rename', { p_old: w.key, p_new: nk, p_title: name, p_events: w.events.map(e => e.id) });
          if (error || !data || data.error) { api.toast(error ? 'Could not rename: ' + (/client_rename/.test(error.message) ? 'run supabase/031_client_rename.sql first.' : error.message) : data.error); btn.disabled = false; btn.textContent = 'Rename'; return; }
        }
        w.events.forEach(e => { e.wedding = name; }); api.save(); if (window.MUTOS_APP && window.MUTOS_APP.changed) window.MUTOS_APP.changed(); api.renderBoard();
        lastSig.delete(w.key); await load(); await sync();
        api.toast(w.title + ' is now ' + name + ' (' + w.events.length + ' shoot' + (w.events.length > 1 ? 's' : '') + ').'); open();
      } catch (e) { api.toast('Could not rename: ' + (e.message || e)); btn.disabled = false; btn.textContent = 'Rename'; }
    });
  }
  function moneyPill(key) {
    if (sup()) return '';
    const m = money(key); if (!m) return '';
    if (m.overdue > 0) return '<span class="pill no" style="font-size:11px;white-space:nowrap">' + inr(m.overdue) + ' overdue' + '</span>';
    if (m.pending <= 0) return '<span class="pill ok" style="font-size:11px">Paid in full</span>';
    return '<span class="pill mute" style="font-size:11px;white-space:nowrap">' + inr(m.pending) + ' to come' + (m.next ? ' · next ' + dayName(m.next.due) : '') + '</span>';
  }

  // ---------- package & payments of one wedding ----------
  function booking(w) {
    if (sup()) return;
    const old = bookings.find(b => b.wedding_key === w.key), m = money(w.key);
    const x = old ? JSON.parse(JSON.stringify(old)) : { items: [], plan: [], total: 0, lock_on: false, grace_days: 3, package_id: null, package_name: '' };
    const pays = payments.filter(p => p.wedding_key === w.key);
    const itemRow = (it, i) => '<div class="bk-it" data-i="' + i + '" style="display:grid;grid-template-columns:1.3fr 1fr .7fr auto;gap:6px;margin:4px 0"><select class="sb-field" data-f="kind">' + KIND_LABELS.map(([k, l]) => '<option value="' + k + '"' + (it.kind === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
      '<select class="sb-field" data-f="per"><option value="wedding"' + (it.per !== 'function' ? ' selected' : '') + '>whole wedding</option><option value="function"' + (it.per === 'function' ? ' selected' : '') + '>each function</option></select>' +
      '<input class="sb-field" data-f="note" placeholder="e.g. 40 sheets" value="' + esc(it.note || '') + '"><button type="button" class="sb-btn-sm secondary" data-rm-it="' + i + '">✕</button></div>';
    const planRow = (p2, i) => '<div class="bk-pl" data-i="' + i + '" style="display:grid;grid-template-columns:1.2fr 1fr 1fr auto;gap:6px;margin:4px 0"><input class="sb-field" data-f="label" placeholder="Advance / Before wedding" value="' + esc(p2.label || '') + '"><input class="sb-field" type="date" data-f="due" value="' + esc(p2.due || '') + '">' +
      '<input class="sb-field" type="number" min="0" data-f="amount" placeholder="₹" value="' + esc(p2.amount || '') + '"><button type="button" class="sb-btn-sm secondary" data-rm-pl="' + i + '">✕</button></div>';
    const html = '<div style="padding:0 16px 8px;overflow-y:auto;flex:1;min-height:0">' +
      (m ? '<div class="sb-manage-sub" style="margin-bottom:8px;font-size:13px"><b>' + inr(m.paid) + '</b> received of ' + inr(m.b.total) + ' · <b>' + inr(m.pending) + '</b> to come' + (m.overdue ? ' · <b style="color:#7a2d1e">' + inr(m.overdue) + ' overdue' + '' + '</b>' : '') + (m.next ? ' · next: ' + esc(m.next.label || '') + ' ' + inr(m.next.amount) + ' on ' + esc(dayName(m.next.due)) : '') + '</div>' : '') +
      '<label class="sb-manage-sub">Package<select class="sb-field" id="bk-pkg"><option value="">Custom (no package)</option>' + packages.filter(p2 => p2.active || p2.id === x.package_id).map(p2 => '<option value="' + p2.id + '"' + (p2.id === x.package_id ? ' selected' : '') + '>' + esc(p2.name) + (Number(p2.price) ? ' · ' + inr(p2.price) : '') + '</option>').join('') + '</select></label>' +
      '<label class="sb-manage-sub" style="display:block;margin-top:8px">Total agreed (₹)<input class="sb-field" id="bk-total" type="number" min="0" value="' + esc(x.total || '') + '"></label>' +
      '<div class="sb-manage-sub" style="margin-top:10px"><b>Deliverables</b> (the work desk can add these as jobs in one tap)</div><div id="bk-items">' + x.items.map(itemRow).join('') + '</div><button type="button" class="sb-btn-sm secondary" id="bk-add-it">＋ Deliverable</button>' +
      '<div class="sb-manage-sub" style="margin-top:12px"><b>Payment plan</b></div><div id="bk-plan">' + x.plan.map(planRow).join('') + '</div><button type="button" class="sb-btn-sm secondary" id="bk-add-pl">＋ Instalment</button>' +
      '<label class="sb-manage-sub" style="display:flex;gap:8px;align-items:center;margin-top:12px">A payment counts as overdue <input class="sb-field" id="bk-grace" type="number" min="0" max="60" value="' + esc(x.grace_days) + '" style="width:60px;display:inline-block"> days after its date (the family sees a reminder; their details never lock)</label>' +
      '<label class="sb-manage-sub" style="display:block;margin-top:8px">Notes<textarea class="sb-field" id="bk-notes" rows="2">' + esc(x.notes || '') + '</textarea></label>' +
      '<div class="sb-manage-sub" style="margin-top:14px"><b>Payments received</b></div>' + (pays.length ? pays.map(p2 => '<div class="sb-manage-sub" style="display:flex;justify-content:space-between;border-top:1px dashed #e8dccf;padding:5px 0"><span>' + esc(dayName(p2.paid_on)) + ' · ' + esc(p2.mode) + (p2.note ? ' · ' + esc(p2.note) : '') + '</span><b>' + inr(p2.amount) + '</b></div>').join('') : '<div class="sb-manage-sub">None yet.</div>') +
      (old ? '<div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:6px;margin-top:6px"><input class="sb-field" id="py-amt" type="number" min="1" placeholder="Amount ₹"><input class="sb-field" id="py-date" type="date" value="' + todayIST() + '"><select class="sb-field" id="py-mode">' + ['UPI', 'Bank', 'Cash', 'Cheque', 'Other'].map(o => '<option>' + o + '</option>').join('') + '</select><button type="button" class="sb-btn-sm" id="py-add">Add</button></div><input class="sb-field" id="py-note" placeholder="Note (optional)" style="margin-top:4px">' : '<div class="sb-manage-sub">Save first, then add payments.</div>') +
      '</div>';
    const modal = api.makeModal(api.modalHead('Package & payments · ' + w.title, 'Only the admin and the manager see money. The family sees their package, what is paid and the next due date on their page.') + html +
      '<div class="sb-modal-foot"><button type="button" class="secondary" id="bk-back">← Clients</button>' + (m && m.pending > 0 ? '<a class="sb-btn-sm wa" id="bk-wa" href="#" style="align-self:center">Payment reminder</a>' : '') + '<button type="button" id="bk-save">Save</button></div>', true);
    const q = sel => modal.querySelector(sel);
    const readRows = () => {
      x.items = [...modal.querySelectorAll('.bk-it')].map(r => ({ kind: r.querySelector('[data-f="kind"]').value, per: r.querySelector('[data-f="per"]').value, note: r.querySelector('[data-f="note"]').value.trim() || undefined }));
      x.plan = [...modal.querySelectorAll('.bk-pl')].map(r => ({ label: r.querySelector('[data-f="label"]').value.trim(), due: r.querySelector('[data-f="due"]').value, amount: Number(r.querySelector('[data-f="amount"]').value) || 0 }));
    };
    const redraw = () => { q('#bk-items').innerHTML = x.items.map(itemRow).join(''); q('#bk-plan').innerHTML = x.plan.map(planRow).join(''); wireRows(); };
    const wireRows = () => {
      modal.querySelectorAll('[data-rm-it]').forEach(b => b.onclick = () => { readRows(); x.items.splice(Number(b.dataset.rmIt), 1); redraw(); });
      modal.querySelectorAll('[data-rm-pl]').forEach(b => b.onclick = () => { readRows(); x.plan.splice(Number(b.dataset.rmPl), 1); redraw(); });
    };
    wireRows();
    q('#bk-add-it').addEventListener('click', () => { readRows(); x.items.push({ kind: 'reel', per: 'wedding' }); redraw(); });
    q('#bk-add-pl').addEventListener('click', () => { readRows(); x.plan.push({ label: x.plan.length ? '' : 'Advance', due: x.plan.length ? '' : todayIST(), amount: '' }); redraw(); });
    q('#bk-pkg').addEventListener('change', () => {
      const p2 = packages.find(k => k.id === q('#bk-pkg').value); if (!p2) return;
      readRows(); x.items = JSON.parse(JSON.stringify(p2.items || [])); if (Number(p2.price)) q('#bk-total').value = p2.price; redraw();
    });
    q('#bk-back').addEventListener('click', open);
    q('#bk-save').addEventListener('click', async () => {
      readRows();
      const total = Number(q('#bk-total').value) || 0, planSum = x.plan.reduce((s2, p2) => s2 + p2.amount, 0);
      if (x.plan.some(p2 => !p2.due || !(p2.amount > 0))) { api.toast('Each instalment needs a date and an amount.'); return; }
      if (planSum > total) { api.toast('The instalments (' + inr(planSum) + ') are more than the total (' + inr(total) + ').'); return; }
      const p2 = packages.find(k => k.id === q('#bk-pkg').value);
      const row = { wedding_key: w.key, title: w.title.slice(0, 120), package_id: p2 ? p2.id : null, package_name: p2 ? p2.name : (x.package_name && !x.package_id ? x.package_name : 'Custom'), items: x.items, total, plan: x.plan.map(p3 => ({ label: p3.label || 'Instalment', due: p3.due, amount: p3.amount })),
        lock_on: !!x.lock_on, grace_days: Math.max(0, Math.min(60, Number(q('#bk-grace').value) || 0)), notes: q('#bk-notes').value.trim() || null };
      const c = await app.client(); const { error } = await c.from('bookings').upsert(row);
      if (error) { api.toast('Could not save: ' + error.message + (/bookings/.test(error.message) ? ' (run supabase/009_bookings.sql)' : '')); return; }
      await load(); document.dispatchEvent(new Event('mutos:updates')); api.toast(planSum < total ? 'Saved. ' + inr(total - planSum) + ' of the total has no instalment date yet.' : 'Saved.'); booking(w);
    });
    const pa = q('#py-add'); if (pa) pa.addEventListener('click', async () => {
      const amount = Number(q('#py-amt').value); if (!(amount > 0)) { api.toast('Enter the amount received.'); return; }
      const c = await app.client(); const { error } = await c.from('booking_payments').insert({ wedding_key: w.key, amount, paid_on: q('#py-date').value || todayIST(), mode: q('#py-mode').value, note: q('#py-note').value.trim() || null });
      if (error) { api.toast('Could not save: ' + error.message); return; }
      await load(); document.dispatchEvent(new Event('mutos:updates')); api.toast(inr(amount) + ' recorded.'); booking(w);
    });
    const wa = q('#bk-wa'); if (wa && m) {
      const amt = m.overdue > 0 ? m.overdue : (m.next ? Math.min(m.next.amount, m.pending) : m.pending);
      const msg = 'Namaste! This is Muto\'s. A gentle reminder for ' + w.title + ': ' + inr(amt) + (m.overdue > 0 ? ' was due' : m.next ? ' is due on ' + dayName(m.next.due) : ' is pending') + '. Received so far: ' + inr(m.paid) + ' of ' + inr(m.b.total) + '. You can see the details when you sign in at ' + linkOf() + '. Thank you!';
      wa.href = 'https://wa.me/' + (digits(w.phone) || '') + '?text=' + encodeURIComponent(msg); wa.target = '_blank'; wa.rel = 'noopener';
    }
  }

  // ---------- packages ----------
  function packagesWin() {
    if (sup()) return;
    const list = '<div class="sb-modal-list">' + (packages.length ? packages.map(p2 => '<div class="sb-manage-row" style="display:block;padding:10px 8px"><div style="display:flex;justify-content:space-between;gap:8px"><b>' + esc(p2.name) + (p2.active ? '' : ' (not offered)') + '</b><span>' + inr(p2.price) + '</span></div><div class="sb-manage-sub">' + esc((p2.items || []).map(itemText).join(' · ') || 'No deliverables yet') + '</div><div class="sb-btn-row" style="margin-top:6px"><button type="button" class="sb-btn-sm secondary" data-pk="' + p2.id + '">Edit</button></div></div>').join('') : '<p class="sb-modal-empty">No packages yet.</p>') + '</div>';
    const modal = api.makeModal(api.modalHead('Packages', 'Price and what is delivered. Picking a package on a wedding copies these; you can still change them for that wedding.') + list + '<div class="sb-modal-foot"><button type="button" class="secondary" id="pk-back">← Clients</button><button type="button" id="pk-new">＋ New package</button></div>', true);
    modal.querySelector('#pk-back').addEventListener('click', open);
    modal.querySelector('#pk-new').addEventListener('click', () => editPackage(null));
    modal.querySelectorAll('[data-pk]').forEach(b => b.addEventListener('click', () => editPackage(packages.find(p2 => p2.id === b.dataset.pk))));
  }
  function editPackage(pk) {
    const x = pk ? JSON.parse(JSON.stringify(pk)) : { name: '', price: 0, items: [], notes: '', active: true };
    const row = (it, i) => '<div class="pk-it" style="display:grid;grid-template-columns:1.3fr 1fr .7fr auto;gap:6px;margin:4px 0"><select class="sb-field" data-f="kind">' + KIND_LABELS.map(([k, l]) => '<option value="' + k + '"' + (it.kind === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select><select class="sb-field" data-f="per"><option value="wedding"' + (it.per !== 'function' ? ' selected' : '') + '>whole wedding</option><option value="function"' + (it.per === 'function' ? ' selected' : '') + '>each function</option></select><input class="sb-field" data-f="note" value="' + esc(it.note || '') + '" placeholder="e.g. 40 sheets"><button type="button" class="sb-btn-sm secondary" data-rm="' + i + '">✕</button></div>';
    const modal = api.makeModal(api.modalHead(pk ? 'Edit ' + pk.name : 'New package', '') + '<div style="padding:0 16px 8px;overflow-y:auto;flex:1;min-height:0"><label class="sb-manage-sub">Name<input class="sb-field" id="pk-n" maxlength="80" value="' + esc(x.name) + '"></label><label class="sb-manage-sub" style="display:block;margin-top:6px">Price (₹)<input class="sb-field" id="pk-p" type="number" min="0" value="' + esc(x.price) + '"></label>' +
      '<div class="sb-manage-sub" style="margin-top:10px"><b>Deliverables</b></div><div id="pk-items">' + x.items.map(row).join('') + '</div><button type="button" class="sb-btn-sm secondary" id="pk-add">＋ Deliverable</button>' +
      '<label class="sb-manage-sub" style="display:block;margin-top:8px">Notes<input class="sb-field" id="pk-no" maxlength="500" value="' + esc(x.notes || '') + '"></label><label class="sb-manage-sub" style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="pk-a"' + (x.active ? ' checked' : '') + '> Offered now</label></div>' +
      '<div class="sb-modal-foot"><button type="button" class="secondary" id="pk-cx">← Packages</button><button type="button" id="pk-save">Save</button></div>', true);
    const read = () => { x.items = [...modal.querySelectorAll('.pk-it')].map(r => ({ kind: r.querySelector('[data-f="kind"]').value, per: r.querySelector('[data-f="per"]').value, note: r.querySelector('[data-f="note"]').value.trim() || undefined })); };
    const redraw = () => { modal.querySelector('#pk-items').innerHTML = x.items.map(row).join(''); modal.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { read(); x.items.splice(Number(b.dataset.rm), 1); redraw(); }); };
    redraw();
    modal.querySelector('#pk-add').addEventListener('click', () => { read(); x.items.push({ kind: 'reel', per: 'wedding' }); redraw(); });
    modal.querySelector('#pk-cx').addEventListener('click', packagesWin);
    modal.querySelector('#pk-save').addEventListener('click', async () => {
      read(); const name = modal.querySelector('#pk-n').value.trim(); if (!name) { api.toast('Give the package a name.'); return; }
      const r = { name, price: Number(modal.querySelector('#pk-p').value) || 0, items: x.items, notes: modal.querySelector('#pk-no').value.trim() || null, active: modal.querySelector('#pk-a').checked };
      const c = await app.client(); const { error } = pk ? await c.from('packages').update(r).eq('id', pk.id) : await c.from('packages').insert(r);
      if (error) { api.toast('Could not save: ' + error.message); return; }
      await load(); api.toast('Saved.'); packagesWin();
    });
  }

  // which Gmails may sign in for this wedding
  function gmails(w) {
    const l = links.find(x => x.wedding_key === w.key), cur = (l && l.emails) || [];
    const modal = api.makeModal(api.modalHead('Client Gmails · ' + w.title, 'The family signs in with Google using one of these Gmails (bride, groom, a parent; up to 6). Write them one per line or separated by commas.') +
      '<div style="padding:0 16px 8px"><textarea class="sb-field" id="cg-mails" rows="4" placeholder="akriti@gmail.com, rohan@gmail.com">' + esc(cur.join('\n')) + '</textarea>' +
      (w.phone ? '' : '<div class="sb-manage-sub" style="margin-top:6px">No phone number on this wedding\'s shoots: WhatsApp will ask you to pick the chat.</div>') + '</div>' +
      '<div class="sb-modal-foot"><button type="button" class="secondary" id="cg-back">← Clients</button><button type="button" id="cg-save">Save</button></div>');
    modal.querySelector('#cg-back').addEventListener('click', open);
    modal.querySelector('#cg-save').addEventListener('click', async () => {
      const list = parseMails(modal.querySelector('#cg-mails').value), bad = list.filter(e => !okMail(e));
      if (bad.length) { api.toast('Check these: ' + bad.join(', ')); return; }
      if (list.length > 6) { api.toast('Up to 6 Gmails per wedding.'); return; }
      const c = await app.client();
      const { error } = l ? await c.from('client_links').update({ emails: list }).eq('wedding_key', w.key)
        : await c.from('client_links').insert({ wedding_key: w.key, title: w.title.slice(0, 120), phone: w.phone || null, emails: list });
      if (error) { api.toast('Could not save: ' + error.message); return; }
      await load(); lastSig.delete(w.key); await sync(); api.toast(list.length ? 'Saved. Now send it on WhatsApp.' : 'Saved. Nobody can sign in for this wedding.'); open();
    });
  }

  // what the family wrote, next to the board, with "Apply to board"
  // ── where is this client's data (11 Nov 2026, Ravi): every drive line for the wedding (raw, backup, project, render, final),
  // which drive and who has it now, cards from its functions not copied yet, and a warning where a function has no backup ──
  function findData(back) {
    const all = weddings(true);
    const row = w => '<button type="button" class="sb-manage-row" data-dw="' + esc(w.key) + '" style="display:block;width:100%;text-align:left;padding:10px 8px;background:none;border:0;border-bottom:1px solid var(--line,#eee);cursor:pointer;font:inherit;color:inherit"><b>' + esc(w.title) + '</b><br><span class="sb-manage-sub">' + esc(dayName(w.first) + (w.last !== w.first ? ' – ' + dayName(w.last) : '') + ' · ' + w.events.length + ' function' + (w.events.length > 1 ? 's' : '')) + '</span></button>';
    const modal = api.makeModal(api.modalHead('Find client data', 'Type the client or wedding name. Past weddings are here too.') +
      '<div style="padding:0 2px 8px;display:flex;gap:8px;flex-wrap:wrap"><input class="sb-input" id="fd-q" type="search" placeholder="e.g. Sharma" style="flex:1 1 180px;min-width:0;min-height:42px;border-radius:12px;border:1px solid var(--line,#ddd);padding:8px 12px;font:inherit;box-sizing:border-box">' + sortSel('fd-sort', getSort('data')) + '</div><div class="sb-modal-list" id="fd-list"></div>' +
      '<div class="sb-modal-foot"><button type="button" class="secondary" id="fd-back">' + (back ? '← Back' : 'Close') + '</button></div>', true);
    const list = modal.querySelector('#fd-list'), q = modal.querySelector('#fd-q');
    const so = modal.querySelector('#fd-sort');
    so.addEventListener('change', () => { setSort('data', so.value); draw(); });
    const draw = () => { const t = q.value.trim().toLowerCase(), hit = sortWs(all.filter(w => !t || w.title.toLowerCase().includes(t) || w.events.some(e => String(e.name).toLowerCase().includes(t))), so.value, true).slice(0, t ? 200 : 60);
      list.innerHTML = hit.length ? hit.map(row).join('') : '<p class="sb-modal-empty">No wedding with that name on the board.</p>';
      list.querySelectorAll('[data-dw]').forEach(b => b.addEventListener('click', () => dataWin(all.find(w => w.key === b.dataset.dw), () => findData(back)))); };
    q.addEventListener('input', draw); draw(); setTimeout(() => q.focus(), 50);
    modal.querySelector('#fd-back').addEventListener('click', () => back ? back() : api.closeModal());
  }
  // ---------- the client's history (12 Nov 2026, Ravi): admin and manager only ----------
  // every card line while a card held this wedding's footage (used, given, received by whom, copied, backup, moved to / from
  // another shoot: client_log, 022), the family's form going onto the board (client_apply_log) and payments, newest first
  async function histWin(w, back) {
    if (!w || sup()) return;
    const modal = api.makeModal(api.modalHead('History · ' + w.title, 'Cards, the family\'s form and payments. Only the admin and the manager see this.') + '<div class="sb-modal-list" id="hw-body"><p class="sb-modal-empty">Loading…</p></div><div class="sb-modal-foot"><button type="button" class="secondary" id="hw-back">← Back</button><button type="button" class="secondary" id="hw-data">Data</button></div>', true);
    modal.querySelector('#hw-back').addEventListener('click', () => back ? back() : api.closeModal());
    modal.querySelector('#hw-data').addEventListener('click', () => dataWin(w, () => histWin(w, back)));
    const c = await app.client(), q = async p => { try { const r = await p; return r && !r.error ? r.data || [] : []; } catch (e) { return []; } };
    const evIds = w.events.map(e => e.id);
    const [cl, ap, pays] = await Promise.all([
      q(c.from('client_log').select('*').in('event_id', evIds).order('at', { ascending: false }).limit(500)),
      q(c.from('client_apply_log').select('*').eq('wedding_key', w.key).order('at', { ascending: false }).limit(100)),
      q(c.from('booking_payments').select('*').eq('wedding_key', w.key))
    ]);
    const fn = id => { const e = w.events.find(x => x.id === id); return e ? (window.MutosWork ? window.MutosWork.fnName(e, w) : e.name) : ''; };
    const rows = []
      .concat(cl.map(l => ({ at: l.at, tag: fn(l.event_id), kind: /moved/i.test(l.what) ? 'Moved' : /received|accepted/i.test(l.what) ? 'Received' : /copied/i.test(l.what) ? 'Copied' : /given/i.test(l.what) ? 'Given' : /Used:/.test(l.what) ? 'Card used' : 'Card', what: l.what, by: l.by_email })))
      .concat(ap.map(l => ({ at: l.at, tag: fn(l.event_id), kind: 'Family form', what: 'Put on the board: ' + [l.after && l.after.location ? 'venue ' + l.after.location : '', l.before && l.before.location && l.after && l.before.location !== l.after.location ? '(was ' + l.before.location + ')' : '', l.after && l.after.notes && /From client:/.test(l.after.notes) ? 'notes updated' : ''].filter(Boolean).join(' '), by: l.by_email || 'the family' })))
      .concat(pays.map(p => ({ at: p.at || p.paid_on, tag: '', kind: 'Payment', what: inr(p.amount) + ' received (' + p.mode + ')' + (p.note ? ' · ' + p.note : '') + ' · paid ' + dayName(p.paid_on), by: p.by_email })))
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const day = ts => new Date(ts).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    const tm = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    let last = '', h = '';
    rows.forEach(r => { const d = day(r.at); if (d !== last) { h += '<div class="sb-manage-sub" style="padding:10px 8px 2px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;font-size:11px">' + esc(d) + '</div>'; last = d; }
      h += '<div class="sb-manage-row hw-row" style="display:block;padding:8px"><span class="pill mute" style="font-size:11px;margin-right:6px">' + esc(r.kind) + '</span>' + (r.tag ? '<b>' + esc(r.tag) + '</b> · ' : '') + esc(r.what) + '<div class="sb-manage-sub">' + esc(tm(r.at) + (r.by ? ' · ' + r.by : '')) + '</div></div>'; });
    const body = modal.querySelector('#hw-body'); if (!body) return;
    body.innerHTML = rows.length ? h : '<p class="sb-modal-empty">Nothing yet. Card notes, handovers and copies for this wedding show here.</p>';
  }

  async function dataWin(w, back) {
    if (!w) return;
    const modal = api.makeModal(api.modalHead('Data · ' + w.title, 'Loading…') + '<div class="sb-modal-list" id="dw-body"><p class="sb-modal-empty">Loading…</p></div><div class="sb-modal-foot"><button type="button" class="secondary" id="dw-back">← Back</button>' + (sup() ? '' : '<button type="button" class="secondary" id="dw-hist">History</button>') + '<a class="sb-btn-sm secondary" href="/desk.html?tab=drives" style="align-self:center">Open Drives</a></div>', true);
    { const hb = modal.querySelector('#dw-hist'); if (hb) hb.addEventListener('click', () => histWin(w, () => dataWin(w, back))); }
    modal.querySelector('#dw-back').addEventListener('click', () => back ? back() : api.closeModal());
    const c = await app.client(), q = async p => { try { const r = await p; return r && !r.error ? r.data || [] : []; } catch (e) { return []; } };
    const evIds = w.events.map(e => e.id), tl = w.title.toLowerCase();
    const [linked, loose, drives, dir, uses] = await Promise.all([
      q(c.from('drive_items').select('*').eq('wedding_key', w.key)),
      q((async () => { const out = []; for (let from = 0; from < 200000; from += 1000) { const r = await c.from('drive_items').select('*').is('wedding_key', null).ilike('title', '%' + w.title.replace(/[%_]/g, '') + '%').order('id').range(from, from + 999); if (r.error) return from ? { data: out } : r; out.push(...(r.data || [])); if (!r.data || r.data.length < 1000) break; } return { data: out }; })()),
      q(c.from('drives').select('id, name, holder, status, owner_type')),
      q(c.rpc('people_directory')),
      q(c.from('card_uses').select('id, card, cycle, event_id, shoot, media, style, used').in('event_id', evIds))
    ]);
    const items = linked.concat(loose.filter(i => String(i.title || '').toLowerCase().includes(tl)));
    const cardIds = [...new Set(uses.map(u => u.card))];
    const [cards, copies] = cardIds.length ? await Promise.all([q(c.from('cards').select('id, code, holder, data, cycle').in('id', cardIds)), q(c.from('card_copies').select('card, cycle, backup, drive_name, folder, files, items').in('card', cardIds))]) : [[], []];
    const who = id => id ? ((dir.find(p => p.id === id) || {}).name || 'someone') : 'the office';
    const drv = id => drives.find(d => d.id === id) || { name: '?' };
    const where = d => d.status === 'delivered' ? 'given to the client' : d.status === 'retired' || d.status === 'faulty' ? d.status : d.holder ? 'with ' + who(d.holder) : 'in the office';
    // which function a line belongs to: the card copy that made it, else its title
    const itemEv = new Map(), itemCopy = new Map();
    copies.forEach(cp => (cp.items || []).forEach(id => itemCopy.set(id, cp)));
    copies.forEach(cp => uses.filter(u => u.card === cp.card && u.cycle === cp.cycle && u.used).forEach(u => (cp.items || []).forEach(id => itemEv.set(id, u.event_id))));
    const short = ev => { const n = String(ev.name || ''); return n.toLowerCase().startsWith(tl + ' ') ? n.slice(w.title.length + 1) : n; };
    const evOf = it => itemEv.get(it.id) || (w.events.find(ev => String(it.title || '').toLowerCase().includes(short(ev).toLowerCase())) || {}).id || null;
    const now = items.filter(i => !i.removed_at), old = items.filter(i => i.removed_at);
    const WHAT = { raw: 'Raw', backup: 'Backup', project: 'Project', render: 'Render', final: 'Final', other: 'Other' };
    // each line opens that drive at its folder (Work desk → Drives), where it can be checked, copied, backed up or moved
    const goHref = it => 'desk.html?tab=drives&drive=' + encodeURIComponent(it.drive) + (it.removed_at ? '' : '&item=' + encodeURIComponent(it.id));
    const goLink = it => '<a class="dw-open" href="' + goHref(it) + '" style="float:right;margin-left:8px;font-size:12px;font-weight:600;white-space:nowrap">Open in drive ›</a>';
    const line = it => { const d = drv(it.drive); return '<div style="font-size:12.5px;line-height:1.55">' + goLink(it) + '<b>' + esc(WHAT[it.what] || it.what) + '</b> · <b>' + esc(d.name) + '</b> <span class="sb-manage-sub">(' + esc(where(d)) + ')</span>' + (it.size_label ? ' · ' + esc(it.size_label) : '') + '<br><span class="sb-manage-sub">' + esc([it.title, it.note].filter(Boolean).join(' · ')) + '</span></div>'; };
    const today = api.todayStr(); let warn = 0, html = '';
    w.events.forEach(ev => {
      const mine = now.filter(i => evOf(i) === ev.id), raw = mine.filter(i => i.what === 'raw'), bk = mine.filter(i => i.what === 'backup');
      const open = uses.filter(u => u.event_id === ev.id && u.used).map(u => ({ u, k: cards.find(k => k.id === u.card) })).filter(x => x.k && x.k.cycle === x.u.cycle && x.k.data === 'hold');
      const past = ev.date <= today;
      let flag = '';
      if (open.length) flag = '<div style="color:#7a2d1e;font-size:12.5px"><b>⚠ Not copied yet:</b> ' + esc(open.map(x => x.k.code + ' (' + (x.k.holder ? 'with ' + who(x.k.holder) : 'in the office') + ')').join(', ')) + '</div>';
      if (past && !mine.length && !open.length) flag += '<div style="color:#7a2d1e;font-size:12.5px"><b>⚠ Nothing listed on any drive</b> for this function.</div>';
      // a raw line is safe when a backup of the same thing (same title) is on another drive
      // (from a card: the same card and round has a backup copy; typed by hand: a backup line with the same title on another drive)
      const lone = raw.filter(i => !i.no_backup).filter(i => { const cp = itemCopy.get(i.id); return cp ? !copies.some(x => x.card === cp.card && x.cycle === cp.cycle && x.backup) : !bk.some(b => b.title === i.title && b.drive !== i.drive); });
      const cardOf = i => { const cp = itemCopy.get(i.id), k = cp && cards.find(x => x.id === cp.card); return k ? ' · card ' + k.code : ''; };
      if (lone.length) flag += '<div style="color:#5c4410;font-size:12.5px"><b>⚠ No backup</b> of ' + esc(lone.map(i => i.title + cardOf(i) + ' (' + drv(i.drive).name + ')').join(', ')) + '</div>';
      if (flag) warn++;
      html += '<div class="sb-manage-row" style="display:block;padding:10px 8px' + (flag ? ';border-left:3px solid #b23a26' : mine.length ? ';border-left:3px solid #3d7a6e' : '') + '"><b>' + esc(short(ev)) + '</b> <span class="sb-manage-sub">' + esc(dayName(ev.date) + ' · ' + ev.slot) + (raw.length && !lone.length ? ' · ✓ raw + backup' : '') + '</span>' + flag +
        (mine.length ? mine.sort((a, b) => ['raw', 'backup', 'project', 'render', 'final', 'other'].indexOf(a.what) - ['raw', 'backup', 'project', 'render', 'final', 'other'].indexOf(b.what)).map(line).join('') : past ? '' : '<div class="sb-manage-sub">Not shot yet.</div>') + '</div>';
    });
    const rest = now.filter(i => !evOf(i));
    if (rest.length) html += '<div class="sb-manage-row" style="display:block;padding:10px 8px"><b>Other data for ' + esc(w.title) + '</b>' + rest.map(line).join('') + '</div>';
    if (old.length) html += '<details style="padding:8px"><summary class="sb-manage-sub" style="cursor:pointer">History: ' + old.length + ' older line' + (old.length > 1 ? 's' : '') + ' (moved, cleaned or given)</summary>' + old.map(it => '<div style="font-size:12px;line-height:1.5;color:var(--muted,#777)">' + goLink(it) + esc((WHAT[it.what] || it.what) + ' · ' + drv(it.drive).name + ' · ' + it.title + ' · ' + (it.removed_why || 'removed') + ' ' + new Date(it.removed_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })) + '</div>').join('') + '</details>';
    const drivesUsed = [...new Set(now.map(i => drv(i.drive).name))];
    const head = modal.querySelector('.sb-modal-sub');
    const sub = (now.length ? now.length + ' line' + (now.length > 1 ? 's' : '') + ' on ' + drivesUsed.length + ' drive' + (drivesUsed.length > 1 ? 's' : '') + ': ' + drivesUsed.join(', ') : 'Nothing listed on any drive yet') + (warn ? ' · ' + warn + (warn > 1 ? ' functions need' : ' function needs') + ' attention' : now.length ? ' · all safe' : '');
    if (head) head.textContent = 'Every drive line for this wedding, and who has each drive now.';
    modal.querySelector('#dw-body').innerHTML = '<div class="sb-manage-sub" id="dw-sum" style="padding:4px 8px 8px">' + esc(sub) + '</div>' + html;
  }
  function answers(w) {
    const s = stateOf(w), a = (s.it && s.it.data) || {}, extra = a.extra || [];
    const line = (k, v) => v ? '<div><span class="sb-manage-sub">' + esc(k) + ':</span> ' + esc(v) + '</div>' : '';
    const block = x => line('Starts', x.time) + line('Venue', x.venue) + line('Address', x.address) + (x.map ? '<div><span class="sb-manage-sub">Map:</span> <a href="' + esc(x.map) + '" target="_blank" rel="noopener">open</a></div>' : '') +
      line('Contact', [x.contact, x.phone].filter(Boolean).join(' ')) + line('Guests', x.guests) + line('Notes', x.notes) + (x.changed ? '<div style="color:var(--danger-ink,#7a2d1e)"><b>Date or time changed</b> (see notes)</div>' : '');
    let html = '<div class="sb-modal-list">';
    w.events.forEach(ev => {
      const x = a[ev.id];
      html += '<div class="sb-manage-row" style="display:block;padding:10px 8px"><b>' + esc(ev.name) + '</b> <span class="sb-manage-sub">' + esc(dayName(ev.date) + ' · ' + ev.slot) + '</span>' +
        '<div class="sb-manage-sub" style="margin:4px 0">Board now: ' + esc(ev.location || 'no venue') + (ev.mapLink ? ' · map ✓' : '') + '</div>' +
        (() => { const g = applied.find(z => z.wedding_key === w.key && z.event_id === ev.id); return g ? '<div style="font-size:12.5px;color:#1f4d43;margin:2px 0 4px">✓ Put on the board by itself when the family sent it · ' + esc(new Date(g.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })) + (g.before && g.before.location && g.before.location !== (g.after || {}).location ? ' · was: ' + esc(g.before.location) : '') + '</div>' : ''; })() +
        (x ? '<div style="font-size:12.5px;line-height:1.5">' + block(x) + '</div><div class="sb-btn-row" style="margin-top:6px"><button type="button" class="sb-btn-sm" data-apply="' + esc(ev.id) + '">Apply to board</button></div>' : '<div class="sb-manage-sub">Not filled yet.</div>') + '</div>';
    });
    extra.forEach((x, i) => {
      html += '<div class="sb-manage-row" style="display:block;padding:10px 8px;border-left:3px solid var(--gold)"><b>New: ' + esc(x.name || 'Function') + '</b> <span class="sb-manage-sub">' + esc(dayName(x.date) + ' · ' + (x.slot || '')) + '</span><div style="font-size:12.5px;line-height:1.5">' + block(x) + '</div>' +
        (x.date ? '<div class="sb-btn-row" style="margin-top:6px"><button type="button" class="sb-btn-sm" data-add="' + i + '">Add to board as a shoot</button></div>' : '') + '</div>';
    });
    const fnName = id => { const ev = w.events.find(e => e.id === id); return ev ? ev.name : 'all functions'; };
    if ((a.contacts || []).length) html += '<div class="sb-manage-row" style="display:block;padding:10px 8px"><b>People to call on the day</b>' + a.contacts.map(x => '<div style="font-size:12.5px;line-height:1.6">' + esc([x.name, x.rel ? '(' + x.rel + ')' : '', x.phone].filter(Boolean).join(' ')) + ' <span class="sb-manage-sub">· ' + esc(fnName(x.fn)) + '</span></div>').join('') + '</div>';
    if (a.couple && (a.couple.bride || a.couple.groom)) html += '<div class="sb-manage-row cl-couple" style="display:block;padding:10px 8px"><b>The couple</b><div style="font-size:13px;margin-top:2px">' + esc([a.couple.bride ? 'Bride: ' + a.couple.bride : '', a.couple.groom ? 'Groom: ' + a.couple.groom : ''].filter(Boolean).join(' · ')) + '</div></div>';
    if ((a.vip || []).length) html += '<div class="sb-manage-row" style="display:block;padding:10px 8px"><b>Important people to photograph</b><div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px">' + a.vip.map(x => '<div style="width:84px;text-align:center;font-size:11.5px;line-height:1.3">' + (x.photo || x.pid ? '<a href="#" class="ca-ph" data-ph="' + a.vip.indexOf(x) + '" style="display:block;cursor:zoom-in" title="See the photo">' + (x.pid && window.MutosPhotos ? window.MutosPhotos.img(x, 'width:72px;height:72px;object-fit:cover;border-radius:14px;display:block;margin:0 auto 4px', '') : '<img src="' + esc(x.photo) + '" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:14px;display:block;margin:0 auto 4px">') + '</a>' : '<div style="width:72px;height:72px;border-radius:14px;background:#f4d9d0;margin:0 auto 4px"></div>') + '<b>' + esc(x.name || '') + '</b><br><span class="sb-manage-sub">' + esc(x.rel || '') + '</span></div>').join('') + '</div><div class="sb-manage-sub" style="margin-top:6px">The crew on these shoots see them on their page.</div></div>';
    const refs = (a.refs || []).filter(x => x.pid);
    if (refs.length && window.MutosPhotos) html += '<div class="sb-manage-row cl-refs" style="display:block;padding:10px 8px"><b>Reference photos from the family (' + refs.length + ')</b><div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px">' + refs.map((x, i) => '<a href="#" class="ca-rf" data-rf="' + i + '" style="width:84px;text-align:center;font-size:11.5px;line-height:1.3;color:inherit;text-decoration:none;cursor:zoom-in">' + window.MutosPhotos.img(x, 'width:72px;height:72px;object-fit:cover;border-radius:14px;display:block;margin:0 auto 4px', '') + esc(x.note || '') + '<br><span class="sb-manage-sub">' + esc(x.fn ? fnName(x.fn) : 'all functions') + '</span></a>').join('') + '</div><div class="sb-manage-sub" style="margin-top:6px">Full quality in Google Drive → Muto\'s app photos → Families. The crew of each function see them.</div></div>';
    html += '</div>';
    const by = s.it.updated_by && !((s.l && s.l.emails) || []).includes(s.it.updated_by) ? ' · last changed by ' + s.it.updated_by + ' (studio)' : '';
    const modal = api.makeModal(api.modalHead(w.title, (s.it.submitted_at ? 'Sent ' + new Date(s.it.submitted_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + (s.fresh ? ' · new since you last checked' : '') : 'Still filling (not sent yet).') + by) + html +
      '<div class="sb-modal-foot"><button type="button" class="secondary" id="ca-back">← Clients</button><button type="button" id="ca-ok">Mark as checked</button></div>', true);
    modal.querySelector('#ca-back').addEventListener('click', open);
    if (window.MutosPhotos) {   // photos: Drive (pid) or an older small copy in the form; the viewer is the same everywhere
      const P = window.MutosPhotos, cP = app.client(), vp = a.vip.filter(x => x.pid || x.photo);
      cP.then(c => P.fill(modal, c));
      modal.querySelectorAll('.ca-rf').forEach(el => el.addEventListener('click', async e => { e.preventDefault(); P.view(await cP, refs.map(x => ({ pid: x.pid, title: x.note || 'Reference photo', sub: x.fn ? fnName(x.fn) : 'All functions' })), +el.dataset.rf); }));
      modal.querySelectorAll('.ca-ph').forEach(el => el.addEventListener('click', async e => { e.preventDefault(); const x = a.vip[+el.dataset.ph]; P.view(await cP, vp.map(y => ({ pid: y.pid, photo: y.photo, title: y.name, sub: y.rel })), vp.indexOf(x)); }));
    }
    if (!window.MutosPhotos) modal.querySelectorAll('.ca-ph').forEach(el => el.addEventListener('click', e => { e.preventDefault(); const x = a.vip[+el.dataset.ph];
      const ov = document.createElement('div'); ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(20,12,15,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;cursor:zoom-out';
      ov.innerHTML = '<img src="' + esc(x.photo) + '" alt="" style="max-width:92vw;max-height:75vh;border-radius:16px;object-fit:contain"><div style="margin-top:12px;font-weight:700">' + esc(x.name || '') + '</div><div style="opacity:.75;font-size:13px">' + esc(x.rel || '') + ' · tap to close</div>';
      ov.addEventListener('click', () => ov.remove()); document.body.appendChild(ov); }));
    modal.querySelector('#ca-ok').addEventListener('click', async () => {
      const c = await app.client(); const { error } = await c.from('client_itinerary').update({ reviewed_at: new Date().toISOString() }).eq('wedding_key', w.key);
      if (error) api.toast('Could not save: ' + error.message); else { api.toast('Marked as checked.'); await load(); document.dispatchEvent(new Event('mutos:updates')); open(); }
    });
    modal.querySelectorAll('[data-apply]').forEach(b => b.addEventListener('click', () => {
      const ev = api.state().events.find(e => e.id === b.dataset.apply), x = a[b.dataset.apply]; if (!ev || !x) return;
      const venue = [x.venue, x.address].filter(Boolean).join(', ');
      if (venue) ev.location = venue.slice(0, 200);
      if (x.map) ev.mapLink = x.map;
      // the family's note may have several lines: one "From client:" line on the board (020), never piled up
      const famLines = String(x.notes || '').split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
      const note = 'From client: ' + [x.time ? 'starts ' + x.time : '', x.contact || x.phone ? 'contact ' + [x.contact, x.phone].filter(Boolean).join(' ') : '', x.guests ? x.guests + ' guests' : '', famLines.join(' · ')].filter(Boolean).join(' · ');
      if (note.length > 13) { // replaces the previous family line; same rule as client_tidy (021): no repeats, no old copies of the family's note
        const words = t => [...new Set(String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))], famW = new Set(words(note)), seen = new Set();
        const own = String(ev.notes || '').split('\n').filter(l => {
          if (!l.trim() || l.startsWith('From client:')) return false;
          const k = l.trim().replace(/\s+/g, ' ').toLowerCase(); if (seen.has(k)) return false; seen.add(k);
          const w = words(l); return !(w.length >= 4 && w.every(x => famW.has(x)));
        });
        ev.notes = own.concat(note).join('\n');
      }
      api.save(); if (window.MUTOS_APP) window.MUTOS_APP.changed();
      b.textContent = '✓ Applied'; b.disabled = true; api.toast(ev.name + ': venue, map and notes updated on the board.');
    }));
    modal.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
      const x = extra[Number(b.dataset.add)], first = w.events[0];
      const ev = api.cleanEvent({ name: (w.title + ' ' + (x.name || 'Function')).trim(), wedding: first.wedding || (first.contactPhone ? '' : w.title), /* same client grouping as the other functions */ date: x.date, slot: x.slot || 'Evening', location: [x.venue, x.address].filter(Boolean).join(', '), mapLink: x.map || '',
        contactName: first.contactName || '', contactPhone: first.contactPhone || '', tier: first.tier, coverage: first.coverage, notes: 'Added from the client\'s itinerary' + (x.notes ? ': ' + x.notes : '') });
      api.state().events.push(ev); api.save(); if (window.MUTOS_APP) window.MUTOS_APP.changed();
      b.textContent = '✓ Added to the board'; b.disabled = true; api.toast(ev.name + ' added to the board on ' + dayName(ev.date) + '. Assign the crew there.');
    }));
  }

  window.MUTOS_CLIENTS = {
    attach(a) { const first = !api; api = a; if (first) { load().then(() => { sync(); document.dispatchEvent(new Event('mutos:updates')); }).catch(() => {}); setInterval(() => load().then(sync).catch(() => {}), 10 * 60 * 1000); } },
    changed() { clearTimeout(this._t); this._t = setTimeout(sync, 3500); },
    open, summary, money, payments: () => payWin(), _afterWin: k => afterWin(weddings(true).find(w => w.key === k)), data: () => { if (!api) { alert('The board is still loading.'); return; } findData(null); }, _dataWin: (k) => dataWin(weddings(true).find(w => w.key === k), null), _weddings: () => weddings(), _sync: sync, _load: load,
    packages() { if (!api) { alert('The board is still loading.'); return; } load().then(packagesWin).catch(e => api.toast('Could not load packages: ' + (e.message || e))); }
  };
})();
