// Team app, staff side: what the crew said from their own pages.
// "Not available" dates are copied into the board's away list (so pickers warn as usual); requests wait for approval.
// The Team updates window lists requests, "can't make it" answers, unconfirmed shoots, data not handed over and gear out.
(function () {
  const app = window.mutosApp;
  let api = null, aways = [], statuses = [], loaded = false, lastPending = null;
  const MIRROR = 'crew-'; // board away entries made from crew dates have ids "crew-<row id>"
  const pad = n => String(n).padStart(2, '0');
  const dstr = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const today = () => dstr(new Date());
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return dstr(d); };
  const dayName = s => new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  const stamp = t => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const sigOf = s => [s.date, s.slot, s.callTime || '', s.venue || '', s.shoot].join('|');

  // crew members with a login, and what their page shows right now (computed from the board, so always current)
  function people() {
    const A = window.MUTOS_APP, st = api.state();
    const m = A && A.crewGroups ? A.crewGroups() : new Map();
    if (!m.size) st.shooters.concat(st.assistants).forEach(p => { if (!p.email || p.left) return; const k = api.normalizeName(p.name); if (!m.has(k)) m.set(k, { key: k, name: p.name, keys: [k] }); });
    m.forEach(p => { const seen = new Set(); p.shoots = []; (p.keys || [p.key]).forEach(k => api.crewFeedFor(k, addDays(today(), -30)).forEach(s => { if (!seen.has(s.id)) { seen.add(s.id); p.shoots.push(s); } })); });
    return m;
  }
  const keysOf = key => (window.MUTOS_APP && window.MUTOS_APP.keysFor ? window.MUTOS_APP.keysFor(key) : [key]);
  function nameOf(key) { const r = api.recordsForKey(key)[0]; return r ? r.name : key; }

  async function load() {
    const c = await app.client();
    const [a, s] = await Promise.all([
      c.from('crew_away').select('*').gte('date', today()).order('date'),
      c.from('crew_status').select('*').gte('shoot_date', addDays(today(), -30))
    ]);
    if (a.error || s.error) { console.warn('team updates', a.error || s.error); return; }
    aways = a.data; statuses = s.data; loaded = true;
    mirror(); badge(); autoResolve();
  }

  // keep the board's away list in step with accepted crew dates
  function mirror() {
    const st = api.state(), want = new Map();
    aways.filter(r => r.status === 'auto' || r.status === 'approved').forEach(r => {
      // one away entry per board name of this person (a name blocks all its roles; a second name with the same Gmail needs its own)
      keysOf(r.person_key).forEach((k, i) => {
        const rec = st.shooters.find(p => api.normalizeName(p.name) === k) || st.assistants.find(p => api.normalizeName(p.name) === k);
        if (!rec) return;
        const id = MIRROR + r.id + (i ? '~' + i : '');
        want.set(id, { id, personType: st.shooters.includes(rec) ? 'shooter' : 'assistant', personId: rec.id, date: r.date, slot: r.slot, reason: 'Not available (from app)' + (r.reason ? ': ' + r.reason : '') });
      });
    });
    let changed = 0;
    st.unavailability = st.unavailability.filter(u => {
      if (!String(u.id).startsWith(MIRROR)) return true;
      if (u.date < today()) return true; // past ones stay as a record
      const w = want.get(u.id); if (!w) { changed++; return false; }
      want.delete(u.id);
      if (u.date !== w.date || u.slot !== w.slot || u.reason !== w.reason || u.personId !== w.personId) { Object.assign(u, w); changed++; }
      return true;
    });
    want.forEach(w => { st.unavailability.push(w); changed++; });
    if (changed) { (api.saveSystem || api.save)(); api.renderBoard(); } // not an undo step: it follows what the crew did
  }

  function summary() {
    const t = today(), ppl = people();
    const pending = aways.filter(r => r.status === 'pending');
    const cant = [], unconf = [], data = [], gear = [];
    ppl.forEach(p => p.shoots.forEach(s => {
      const st = statuses.find(x => x.person_key === p.key && x.event_id === s.id) || {};
      const stale = st.confirm && st.confirm_sig && st.confirm_sig !== sigOf(s);
      if (s.date >= t) {
        if (st.confirm === 'no' && !stale) cant.push({ p, s, st });
        else if ((!st.confirm || stale) && s.date <= addDays(t, 7)) unconf.push({ p, s, stale });
      } else if (!st.data_at) data.push({ p, s });
      if (st.gear_out_at && !st.gear_back_at) gear.push({ p, s, st });
    }));
    return { pending, cant, unconf, data, gear, ppl };
  }
  function badge() {
    const el = document.getElementById('mutos-upd-n'); if (!el || !loaded) return;
    const s = summary(), n = s.pending.length + s.cant.length;
    el.textContent = n ? String(n) : ''; el.hidden = !n;
    const ids = s.pending.map(r => r.id).join(',');
    if (lastPending !== null && s.pending.length && ids !== lastPending) { const r = s.pending[s.pending.length - 1]; api.toast(nameOf(r.person_key) + ' asked to be off on ' + dayName(r.date) + '. Open Team updates to decide.'); }
    lastPending = ids;
    document.dispatchEvent(new Event('mutos:updates')); // the Home screen redraws its "Needs you" cards
  }

  // tell the crew member on their phone (if they turned reminders on); their page shows it either way
  async function notify(id, auto) {
    try {
      const c = await app.client(), s = await c.auth.getSession();
      const r = await fetch('/api/notify-decision', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s.data.session && s.data.session.access_token) }, body: JSON.stringify({ id, auto: !!auto }) });
      return r.ok ? (await r.json()).sent || 0 : 0;
    } catch (e) { return 0; }
  }
  async function decide(id, status, quiet) {
    const c = await app.client();
    const { error } = await c.from('crew_away').update({ status }).eq('id', id).eq('status', 'pending');
    if (error) { if (!quiet) api.toast('Could not save: ' + error.message); return false; }
    const r = aways.find(x => x.id === id); if (r) { r.status = status; r.decided_at = new Date().toISOString(); }
    mirror(); badge();
    const sent = await notify(id, quiet);
    if (!quiet) { open(); api.toast((status === 'approved' ? 'Approved. They now show as away on that day.' : 'Declined.') + (sent ? ' Sent to their phone too.' : ' They will see it on their page.')); }
    return true;
  }
  // you replaced them on that day's shoot: that answers the request, so approve it and tell them
  let resolving = false;
  async function autoResolve() {
    if (resolving || !loaded) return; resolving = true;
    try {
      const ppl = people(), done = [];
      for (const r of aways.filter(x => x.status === 'pending' && x.why === 'booked')) {
        const p = ppl.get(r.person_key); if (!p) continue;
        if (p.shoots.some(s => s.date === r.date)) continue; // still booked that day
        if (await decide(r.id, 'approved', true)) done.push(r);
      }
      if (done.length) api.toast('Approved ' + done.map(r => nameOf(r.person_key) + ' (' + dayName(r.date) + ')').join(', ') + ': you replaced them, so their day off is confirmed and they were told.');
    } finally { resolving = false; }
  }
  async function dataReceived(p, s) {
    const c = await app.client();
    const { error } = await c.from('crew_status').upsert({ person_key: p.key, event_id: s.id, shoot_date: s.date, data_at: new Date().toISOString(), data_note: 'Marked received by the studio' });
    if (error) { api.toast('Could not save: ' + error.message); return; }
    await load(); open();
  }

  function open() {
    if (!api) return;
    const esc = api.escapeHtml, s = summary();
    const sec = (title, sub, rows) => '<p class="sb-modal-group">' + esc(title) + ' (' + rows.length + ')</p>' + (sub ? '<p class="sb-modal-sub" style="padding:0 8px 4px">' + esc(sub) + '</p>' : '') + (rows.length ? rows.join('') : '<p class="sb-modal-empty">Nothing here.</p>');
    const line = (main, sub, btns) => '<div class="sb-manage-row" style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap"><span><b>' + main + '</b>' + (sub ? '<br><span class="sb-manage-sub">' + sub + '</span>' : '') + '</span>' + (btns ? '<span style="display:flex;gap:6px">' + btns + '</span>' : '') + '</div>';
    const html = api.modalHead('Team updates', 'What the crew told the studio from their own pages. Requests and "can\'t make it" answers need you; the rest is for checking.') + '<div class="sb-modal-list">' +
      sec('Not-available requests to decide', 'Booked that day or within 7 days, so they need your OK. If you replace them on that day\'s shoot, the request is approved for you automatically. Either way they are told.', s.pending.map(r => {
        const p = s.ppl.get(r.person_key), on = p ? p.shoots.filter(x => x.date === r.date) : [];
        return line(esc(nameOf(r.person_key)) + ' · ' + esc(dayName(r.date)) + ' · ' + esc(r.slot),
          esc([r.reason ? '"' + r.reason + '"' : 'No reason given', on.length ? 'Booked on: ' + on.map(x => x.shoot + ' (' + x.slot + ')').join(', ') : 'Within 7 days', 'asked ' + stamp(r.created_at)].join(' · ')),
          '<button type="button" class="sb-btn-sm tu-ok" data-id="' + esc(r.id) + '">Approve</button><button type="button" class="sb-btn-sm secondary tu-no" data-id="' + esc(r.id) + '">Decline</button>');
      })) +
      sec('Can\'t make it', 'They said no to a shoot they are still on. Replace them, and this clears by itself.', s.cant.map(x => line(esc(x.p.name) + ' · ' + esc(x.s.day) + ' · ' + esc(x.s.shoot), esc((x.st.confirm_note ? '"' + x.st.confirm_note + '" · ' : '') + x.s.slot + ' · said ' + stamp(x.st.confirmed_at))))) +
      sec('Not confirmed yet · next 7 days', '', s.unconf.map(x => line(esc(x.p.name) + ' · ' + esc(x.s.day) + ' · ' + esc(x.s.shoot), esc(x.s.slot + (x.stale ? ' · details changed after they confirmed' : ''))))) +
      sec('Data not handed over · last 30 days', '', s.data.map((x, i) => line(esc(x.p.name) + ' · ' + esc(x.s.day) + ' · ' + esc(x.s.shoot), esc(x.s.slot), '<button type="button" class="sb-btn-sm secondary tu-data" data-i="' + i + '">Mark received</button>'))) +
      sec('Studio gear with crew', 'Picked up and not marked returned.', s.gear.map(x => line(esc(x.p.name) + ' · ' + esc((x.s.gear || []).filter(g => g !== 'own kit').join(', ')), esc(x.s.day + ' · ' + x.s.shoot + ' · picked up ' + stamp(x.st.gear_out_at))))) +
      sec('Dates already blocked by crew', 'More than 7 days away and not booked, so they were accepted straight away.', aways.filter(r => r.status === 'auto' || r.status === 'approved').map(r => line(esc(nameOf(r.person_key)) + ' · ' + esc(dayName(r.date)) + ' · ' + esc(r.slot), esc((r.reason || 'No reason') + (r.status === 'approved' ? ' · approved by you' : ''))))) +
      '</div><div class="sb-modal-foot"><button type="button" class="secondary" id="tu-crew">Crew view</button><button type="button" id="tu-done">Done</button></div>';
    const modal = api.makeModal(html, true);
    modal.querySelector('#tu-done').addEventListener('click', () => { api.closeModal(); api.renderBoard(); });
    modal.querySelector('#tu-crew').addEventListener('click', () => { location.href = '/crew.html?preview=1'; });
    modal.querySelectorAll('.tu-ok').forEach(b => b.addEventListener('click', () => decide(b.dataset.id, 'approved')));
    modal.querySelectorAll('.tu-no').forEach(b => b.addEventListener('click', () => decide(b.dataset.id, 'declined')));
    modal.querySelectorAll('.tu-data').forEach(b => b.addEventListener('click', () => { const x = s.data[Number(b.dataset.i)]; if (x) dataReceived(x.p, x.s); }));
  }

  let liveT = null;
  async function live() {
    const c = await app.client();
    c.channel('crew-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crew_away' }, p => { if (p.table && p.table !== 'crew_away') return; clearTimeout(liveT); liveT = setTimeout(load, 400); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'crew_status' }, p => { if (p.table && p.table !== 'crew_status') return; clearTimeout(liveT); liveT = setTimeout(load, 400); })
      .subscribe();
  }

  window.MUTOS_UPDATES = {
    attach(a) { const first = !api; api = a; if (first) { load(); live(); setInterval(load, 5 * 60 * 1000); } },
    changed() { if (loaded) { mirror(); badge(); setTimeout(autoResolve, 1500); } }, // after the board's save reaches the crew pages
    open, summary: () => (loaded ? summary() : null), _state: () => ({ aways, statuses, loaded }), _reload: load
  };
})();
