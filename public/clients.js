// Muto's app, owner and managers: the Clients window. One secret link per wedding; the family fills each function's
// time, venue, address, contact and notes (public/client.html). The board keeps their function list up to date (client_feed).
(function () {
  const app = window.mutosApp;
  let api = null, links = [], itin = [], lastSig = new Map(), bookings = [], payments = [], packages = [];
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
  function weddings() {
    const st = api.state(), today = api.todayStr(), by = new Map();
    st.events.forEach(ev => {
      if (!api.isActive(ev) || !ev.date) return;
      const key = ev.wedding ? 'w:' + api.normalizeName(ev.wedding) : ev.contactPhone ? 'p:' + digits(ev.contactPhone) : 'n:' + api.normalizeName(ev.name);
      if (!by.has(key)) by.set(key, { key, title: ev.wedding || ev.contactName || ev.name, phone: '', events: [] });
      const w = by.get(key); w.events.push(ev); if (!w.phone && ev.contactPhone) w.phone = ev.contactPhone;
    });
    return [...by.values()].map(w => { w.events.sort((a, b) => a.date.localeCompare(b.date)); w.first = w.events[0].date; w.last = w.events[w.events.length - 1].date; return w; })
      .filter(w => w.last >= today).sort((a, b) => a.first.localeCompare(b.first));
  }
  const feedOf = w => ({ functions: w.events.map(ev => ({ id: ev.id, name: ev.name, date: ev.date, slot: ev.slot, venue: ev.location || '' })) });

  async function load() {
    const c = await app.client();
    const [l, i] = await Promise.all([c.from('client_links').select('*'), c.from('client_itinerary').select('*')]);
    if (l.error) throw l.error;
    links = l.data || []; itin = i.error ? [] : (i.data || []);
    // packages and payments (009_bookings.sql); fine if not set up yet
    const [b, p, k] = await Promise.all([c.from('bookings').select('*'), c.from('booking_payments').select('*').order('paid_on'), c.from('packages').select('*').order('name')]);
    bookings = b.error ? [] : (b.data || []); payments = p.error ? [] : (p.data || []); packages = k.error ? [] : (k.data || []);
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
    return { l, it, fresh, label: (it.submitted_at ? (fresh ? 'New answers to check' : 'Checked') : 'Filling') + ' · ' + n + ' of ' + w.events.length + (extra ? ' · +' + extra + ' new function' + (extra > 1 ? 's' : '') : ''), cls: fresh ? 'wait' : it.submitted_at ? 'ok' : 'mute' };
  }
  function summary() {
    if (!api) return null; const ws = weddings(), keys = new Set(ws.map(w => w.key));
    const all = bookings.map(b => money(b.wedding_key)).filter(Boolean);
    return { toCheck: ws.filter(w => stateOf(w).fresh).length, noLink: ws.filter(w => !stateOf(w).l).length, overdue: all.filter(m => m.overdue > 0).length, dueSoon: all.filter(m => m.soon && keys.has(m.b.wedding_key)).length };
  }

  async function open() {
    if (!api) { alert('The board is still loading.'); return; }
    try { await load(); } catch (e) { api.toast('Could not load clients: ' + (e.message || e) + '. Run supabase/004_studio.sql first.'); return; }
    sync();
    const ws = weddings();
    const html = '<div class="sb-modal-list">' + (ws.length ? ws.map(w => {
      const s = stateOf(w);
      return '<div class="sb-manage-row" style="display:block;padding:10px 8px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><b style="font-size:14px">' + esc(w.title) + '</b><br><span class="sb-manage-sub">' + esc(dayName(w.first) + (w.last !== w.first ? ' – ' + dayName(w.last) : '') + ' · ' + w.events.length + ' function' + (w.events.length > 1 ? 's' : '') + (w.phone ? ' · ' + w.phone : '')) + '</span></div>' +
        '<span style="display:flex;flex-direction:column;gap:4px;align-items:flex-end"><span class="pill ' + s.cls + '" style="font-size:11px;white-space:nowrap">' + esc(s.label) + '</span>' + moneyPill(w.key) + '</span></div><div class="sb-btn-row" style="margin-top:8px"><button type="button" class="sb-btn-sm secondary" data-book="' + esc(w.key) + '">' + (bookings.some(b => b.wedding_key === w.key) ? 'Package & payments' : 'Add package') + '</button>' +
        (s.l ? (s.l.emails && s.l.emails.length ? '<a class="sb-btn-sm wa" data-wa="' + esc(w.key) + '" href="#">WhatsApp</a>' : '') + '<button type="button" class="sb-btn-sm secondary" data-mails="' + esc(w.key) + '">Gmails (' + ((s.l.emails || []).length) + ')</button><a class="sb-btn-sm secondary" href="' + esc(previewOf(s.l)) + '" target="_blank" rel="noopener">Preview</a>' + (s.it && s.it.updated_at ? '<button type="button" class="sb-btn-sm" data-see="' + esc(w.key) + '">See answers</button>' : '')
          : '<button type="button" class="sb-btn-sm" data-make="' + esc(w.key) + '">Add client Gmail</button>') + '</div>' +
        (s.l && !(s.l.emails || []).length ? '<div class="sb-manage-sub" style="color:#7a2d1e;margin-top:4px">No Gmail yet: the family cannot sign in. Tap Gmails.</div>' : s.l ? '<div class="sb-manage-sub" style="margin-top:4px">Signs in with: ' + esc(s.l.emails.join(', ')) + '</div>' : '') + '</div>';
    }).join('') : '<p class="sb-modal-empty">No upcoming weddings on the board.</p>') + '</div>';
    const modal = api.makeModal(api.modalHead('Clients', 'Add the family\'s Gmail(s) to a wedding. They sign in at ' + location.host + '/client with that Gmail and fill time, venue, address and contact for every function. Nobody else can open it.') + html + '<div class="sb-modal-foot"><button type="button" class="secondary" id="cl-packages">Packages</button><button type="button" id="cl-done">Done</button></div>', true);
    modal.querySelector('#cl-done').addEventListener('click', api.closeModal);
    const byKey = k => ws.find(w => w.key === k);
    modal.querySelectorAll('[data-make], [data-mails]').forEach(b => b.addEventListener('click', () => gmails(byKey(b.dataset.make || b.dataset.mails))));
    modal.querySelectorAll('[data-wa]').forEach(a => {
      const w = byKey(a.dataset.wa), l = links.find(x => x.wedding_key === w.key);
      const msg = 'Namaste! This is Muto\'s. For ' + w.title + ', please fill in the details of each function (start time, venue, address and a contact person at the venue) so our team reaches on time.\n\nOpen ' + linkOf() + ' and sign in with ' + l.emails.join(' or ') + '\n\nIt takes about 5 minutes and you can change it any time. Thank you!';
      a.href = 'https://wa.me/' + (digits(w.phone) || '') + '?text=' + encodeURIComponent(msg); a.target = '_blank'; a.rel = 'noopener';
    });
    modal.querySelectorAll('[data-see]').forEach(b => b.addEventListener('click', () => answers(byKey(b.dataset.see))));
    modal.querySelectorAll('[data-book]').forEach(b => b.addEventListener('click', () => booking(byKey(b.dataset.book))));
    const pk = modal.querySelector('#cl-packages'); if (pk) pk.addEventListener('click', () => packagesWin());
  }
  function moneyPill(key) {
    const m = money(key); if (!m) return '';
    if (m.overdue > 0) return '<span class="pill no" style="font-size:11px;white-space:nowrap">' + inr(m.overdue) + ' overdue' + '</span>';
    if (m.pending <= 0) return '<span class="pill ok" style="font-size:11px">Paid in full</span>';
    return '<span class="pill mute" style="font-size:11px;white-space:nowrap">' + inr(m.pending) + ' to come' + (m.next ? ' · next ' + dayName(m.next.due) : '') + '</span>';
  }

  // ---------- package & payments of one wedding ----------
  function booking(w) {
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
    const modal = api.makeModal(api.modalHead('Package & payments · ' + w.title, 'Only the owner and partner see money. The family sees their package, what is paid and the next due date on their page.') + html +
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
        (x ? '<div style="font-size:12.5px;line-height:1.5">' + block(x) + '</div><div class="sb-btn-row" style="margin-top:6px"><button type="button" class="sb-btn-sm" data-apply="' + esc(ev.id) + '">Apply to board</button></div>' : '<div class="sb-manage-sub">Not filled yet.</div>') + '</div>';
    });
    extra.forEach((x, i) => {
      html += '<div class="sb-manage-row" style="display:block;padding:10px 8px;border-left:3px solid var(--gold)"><b>New: ' + esc(x.name || 'Function') + '</b> <span class="sb-manage-sub">' + esc(dayName(x.date) + ' · ' + (x.slot || '')) + '</span><div style="font-size:12.5px;line-height:1.5">' + block(x) + '</div>' +
        (x.date ? '<div class="sb-btn-row" style="margin-top:6px"><button type="button" class="sb-btn-sm" data-add="' + i + '">Add to board as a shoot</button></div>' : '') + '</div>';
    });
    const fnName = id => { const ev = w.events.find(e => e.id === id); return ev ? ev.name : 'all functions'; };
    if ((a.contacts || []).length) html += '<div class="sb-manage-row" style="display:block;padding:10px 8px"><b>People to call on the day</b>' + a.contacts.map(x => '<div style="font-size:12.5px;line-height:1.6">' + esc([x.name, x.rel ? '(' + x.rel + ')' : '', x.phone].filter(Boolean).join(' ')) + ' <span class="sb-manage-sub">· ' + esc(fnName(x.fn)) + '</span></div>').join('') + '</div>';
    if ((a.vip || []).length) html += '<div class="sb-manage-row" style="display:block;padding:10px 8px"><b>Important people to photograph</b><div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:6px">' + a.vip.map(x => '<div style="width:84px;text-align:center;font-size:11.5px;line-height:1.3">' + (x.photo ? '<img src="' + esc(x.photo) + '" alt="" style="width:72px;height:72px;object-fit:cover;border-radius:14px;display:block;margin:0 auto 4px">' : '<div style="width:72px;height:72px;border-radius:14px;background:#f4d9d0;margin:0 auto 4px"></div>') + '<b>' + esc(x.name || '') + '</b><br><span class="sb-manage-sub">' + esc(x.rel || '') + '</span></div>').join('') + '</div><div class="sb-manage-sub" style="margin-top:6px">The crew on these shoots see them on their page.</div></div>';
    html += '</div>';
    const modal = api.makeModal(api.modalHead(w.title, s.it.submitted_at ? 'Sent ' + new Date(s.it.submitted_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + (s.fresh ? ' · new since you last checked' : '') : 'Still filling (not sent yet).') + html +
      '<div class="sb-modal-foot"><button type="button" class="secondary" id="ca-back">← Clients</button><button type="button" id="ca-ok">Mark as checked</button></div>', true);
    modal.querySelector('#ca-back').addEventListener('click', open);
    modal.querySelector('#ca-ok').addEventListener('click', async () => {
      const c = await app.client(); const { error } = await c.from('client_itinerary').update({ reviewed_at: new Date().toISOString() }).eq('wedding_key', w.key);
      if (error) api.toast('Could not save: ' + error.message); else { api.toast('Marked as checked.'); await load(); document.dispatchEvent(new Event('mutos:updates')); open(); }
    });
    modal.querySelectorAll('[data-apply]').forEach(b => b.addEventListener('click', () => {
      const ev = api.state().events.find(e => e.id === b.dataset.apply), x = a[b.dataset.apply]; if (!ev || !x) return;
      const venue = [x.venue, x.address].filter(Boolean).join(', ');
      if (venue) ev.location = venue.slice(0, 200);
      if (x.map) ev.mapLink = x.map;
      const note = 'From client: ' + [x.time ? 'starts ' + x.time : '', x.contact || x.phone ? 'contact ' + [x.contact, x.phone].filter(Boolean).join(' ') : '', x.guests ? x.guests + ' guests' : '', x.notes].filter(Boolean).join(' · ');
      if (note.length > 13 && !String(ev.notes || '').includes(note)) ev.notes = (ev.notes ? ev.notes + '\n' : '') + note;
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
    open, summary, money, _weddings: () => weddings(), _sync: sync, _load: load,
    packages() { if (!api) { alert('The board is still loading.'); return; } load().then(packagesWin).catch(e => api.toast('Could not load packages: ' + (e.message || e))); }
  };
})();
