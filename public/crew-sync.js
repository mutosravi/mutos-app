// Team app, staff side: keeps each crew member's "My shoots" page and the login list in step with the board.
// The board calls attach() once its data has loaded and changed() after every save that touches shoots or people.
(function () {
  const app = window.mutosApp;
  let api = null, timer = null, busy = false, again = false, known = null, last = { at: '', feeds: 0, error: '' };
  const sigOf = d => JSON.stringify([d.name, d.shoots]);

  // people with a Login Gmail, grouped by name (a shooter and an assistant with one name are one person: "Ravi · Cine" and
  // "Ravi · Drone" share one page). Entries with different names but the same Gmail are one person too: their page shows
  // the shoots of all of them (keys), under the first name's key.
  function groupCrew(records, norm) {
    const byKey = new Map();
    records.forEach(p => {
      if (!p.email || p.left) return;
      const k = norm(p.name);
      if (!byKey.has(k)) byKey.set(k, { key: k, name: p.name, emails: new Set(), keys: [k] });
      byKey.get(k).emails.add(String(p.email).toLowerCase());
    });
    // join groups that share a Gmail
    const byMail = new Map();
    for (const g of [...byKey.values()]) {
      const other = [...g.emails].map(e => byMail.get(e)).find(Boolean);
      if (other && other !== g) { g.keys.forEach(k => other.keys.push(k)); g.emails.forEach(e => other.emails.add(e)); byKey.delete(g.key); other.emails.forEach(e => byMail.set(e, other)); }
      else g.emails.forEach(e => byMail.set(e, g));
    }
    return byKey;
  }
  function wanted() { const st = api.state(); return groupCrew(st.shooters.concat(st.assistants), api.normalizeName); }
  // every board key that belongs to the person whose page key is `key`
  function keysFor(key) { if (!api) return [key]; const g = wanted().get(key); return g ? g.keys : [key]; }
  function feedFor(g, since) {
    if (g.keys.length === 1) return api.crewFeedFor(g.key, since);
    const seen = new Set(), all = [];
    g.keys.forEach(k => api.crewFeedFor(k, since).forEach(s => { if (!seen.has(s.id)) { seen.add(s.id); all.push(s); } }));
    return all.sort((a, b) => a.date.localeCompare(b.date) || String(a.slot).localeCompare(String(b.slot)));
  }

  async function notifyShoots(c) {
    try { const s = await c.auth.getSession(); const tok = s && s.data && s.data.session && s.data.session.access_token; if (tok) fetch('/api/notify-shoots', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } }).catch(() => {}); } catch (e) {}
  }
  async function push() {
    if (!api) return;
    if (busy) { again = true; return; }
    busy = true;
    try {
      const who = await app.me(), c = await app.client();
      const want = wanted();
      // 1. each person's shoot list
      if (!known) { const { data, error } = await c.from('crew_feed').select('person_key, data'); if (error) throw error; known = new Map(data.map(r => [r.person_key, sigOf(r.data || {})])); }
      let wrote = 0;
      const d30 = new Date(Date.now() - 45 * 864e5), pad = n => String(n).padStart(2, '0'), since = d30.getFullYear() + '-' + pad(d30.getMonth() + 1) + '-' + pad(d30.getDate());
      for (const p of want.values()) {
        const data = { name: p.name, shoots: feedFor(p, since), updated: new Date().toISOString() }; // includes the last 30 days, for data handover and gear return
        const sig = sigOf(data);
        if (known.get(p.key) === sig) continue;
        const { error } = await c.from('crew_feed').upsert({ person_key: p.key, name: p.name, data });
        if (error) throw error;
        known.set(p.key, sig); wrote++;
      }
      const stale = [...known.keys()].filter(k => !want.has(k));
      if (stale.length && window.__mutosRole !== 'supervisor') { const { error } = await c.from('crew_feed').delete().in('person_key', stale); if (error) throw error; stale.forEach(k => known.delete(k)); }
      // 2. who may sign in as crew (only the owner can change logins)
      if (who && who.role === 'owner') {
        const { data: rows, error } = await c.from('members').select('email, role, person_key, display_name');
        if (error) throw error;
        const cur = new Map(rows.map(r => [r.email, r])), desired = new Map();
        want.forEach(p => p.emails.forEach(e => desired.set(e, p)));
        const ups = [];
        desired.forEach((p, e) => { const r = cur.get(e); if (r && r.role !== 'crew') return; if (!r || r.person_key !== p.key || r.display_name !== p.name) ups.push({ email: e, role: 'crew', person_key: p.key, display_name: p.name }); });
        if (ups.length) { const { error: e2 } = await c.from('members').upsert(ups); if (e2) throw e2; }
        const gone = rows.filter(r => r.role === 'crew' && !desired.has(r.email)).map(r => r.email);
        if (gone.length) { const { error: e3 } = await c.from('members').delete().in('email', gone); if (e3) throw e3; }
      }
      // 3. the Gear desk's view: items and who carries what (no client details)
      await pushGear(c);
      // shoots that just appeared in someone's list were queued by the database (018_shoot_notices.sql): send them now
      if (wrote && who && ['owner', 'manager', 'supervisor'].includes(who.role)) notifyShoots(c);
      last = { at: new Date().toISOString(), feeds: want.size, wrote, error: '' };
    } catch (e) {
      last = Object.assign({}, last, { error: String(e && e.message || e) });
      console.error('crew sync', e);
    } finally { busy = false; }
    showStatus();
    if (again) { again = false; return push(); }
  }
  let gearSig = null;
  function gearFeed() {
    const st = api.state(), pad = n => String(n).padStart(2, '0');
    const ds = o => { const d = new Date(Date.now() + o * 864e5); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
    const from = ds(-21), to = ds(60), key = p => api.normalizeName(p.name);
    const people = new Map();
    st.shooters.concat(st.assistants).forEach(p => { if (p.left) return; const k = key(p); if (!people.has(k)) people.set(k, { key: k, name: p.name, role: p.role || '', phone: p.phone || '' }); });
    const items = st.equipment.map(eq => Object.assign({ id: eq.id, name: eq.name, category: eq.category || '', qty: Math.max(1, Math.floor(Number(eq.qty)) || 1), vendor: eq.vendor || '' }, (eq.off || []).some(x => x.d >= from) ? { off: eq.off.filter(x => x.d >= from) } : {}));
    const shoots = st.events.filter(ev => ev.status !== 'cancelled' && ev.date && ev.date >= from && ev.date <= to).map(ev => {
      const carriers = [];
      ev.assignments.forEach(a => { const p = st.shooters.find(x => x.id === a.memberId); if (p && (a.gearIds.length || a.ownKit)) carriers.push({ key: key(p), name: p.name, gear: a.gearIds.slice(), ownKit: !!a.ownKit }); });
      const team = ev.assignments.map(a => st.shooters.find(x => x.id === a.memberId)).concat(ev.assistantIds.map(id => st.assistants.find(x => x.id === id))).filter(Boolean).map(p => ({ key: key(p), name: p.name }));
      return { id: ev.id, date: ev.date, slot: ev.slot, shoot: ev.name, venue: ev.location || '', callTime: ev.callTime || '', carriers, shared: ev.equipmentIds.slice(), team };
    }).sort((a, b) => a.date.localeCompare(b.date) || String(a.slot).localeCompare(String(b.slot)));
    return { items, people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)), shoots, updated: new Date().toISOString() };
  }
  async function pushGear(c) {
    try {
      const data = gearFeed(), sig = JSON.stringify([data.items, data.people, data.shoots]);
      if (gearSig === null) { const { data: row, error } = await c.from('gear_feed').select('data').eq('id', 'main').maybeSingle(); if (error) throw error; gearSig = row ? JSON.stringify([row.data.items, row.data.people, row.data.shoots]) : ''; }
      if (sig === gearSig) return;
      const { error } = await c.from('gear_feed').upsert({ id: 'main', data }); if (error) throw error;
      gearSig = sig;
    } catch (e) { console.warn('gear desk not updated (run supabase/003_gear_desk.sql?)', e && e.message || e); }
  }
  function showStatus() {
    const el = document.getElementById('mutos-feed'); if (!el) return;
    el.textContent = last.error ? '· crew pages not updated' : last.at ? '· ' + last.feeds + ' crew pages up to date' : '';
    el.title = last.error || '';
    el.style.color = last.error ? '#b23a26' : '';
  }

  // owner: see every login, add or remove managers
  async function openLogins() {
    if (!api) { alert('The board is still loading.'); return; }
    const c = await app.client();
    const { data: rows, error } = await c.from('members').select('email, role, person_key, display_name').order('role').order('display_name');
    if (error) { api.toast('Could not load logins: ' + error.message); return; }
    const st = api.state(), esc = api.escapeHtml;
    const noLogin = st.shooters.concat(st.assistants).filter(p => !p.left && !p.email).map(p => p.name);
    const sect = (title, list, removable) => '<p class="sb-modal-group">' + esc(title) + ' (' + list.length + ')</p>' + (list.length ? list.map(r =>
      '<div class="sb-manage-row" style="display:flex;gap:8px;align-items:center;justify-content:space-between"><span><b>' + esc(r.display_name || '') + '</b> <span class="sb-manage-sub">' + esc(r.email) + '</span></span>' +
      (removable ? '<button type="button" class="sb-btn-sm secondary lg-rm" data-e="' + esc(r.email) + '">Remove</button>' : '') + '</div>').join('') : '<p class="sb-modal-empty">None yet.</p>');
    const html = api.modalHead('Team logins', 'Who can sign in to the team app with Google. Crew logins come from the "Login Gmail" on each shooter or assistant (Manage shooters → edit); managers can edit the board but not logins or seasons.') +
      '<div class="sb-modal-list">' +
      sect('Admin', rows.filter(r => r.role === 'owner'), false) +
      sect('Managers · full board', rows.filter(r => r.role === 'manager'), true) +
      '<div class="sb-inline-form" style="padding:0 8px"><input class="sb-field" id="lg-name" placeholder="Manager name" style="flex:1 1 120px"><input class="sb-field" id="lg-email" type="email" placeholder="their Gmail" style="flex:1 1 180px"><button type="button" class="sb-zone-add" id="lg-add">Add manager</button></div>' +
      sect('Supervisors · add shoots, change itinerary & client contact, no crew/gear/money/deleting', rows.filter(r => r.role === 'supervisor'), true) +
      '<div class="sb-inline-form" style="padding:0 8px"><input class="sb-field" id="lg-sname" placeholder="Supervisor name" style="flex:1 1 120px"><input class="sb-field" id="lg-semail" type="email" placeholder="their Gmail" style="flex:1 1 180px"><button type="button" class="sb-btn-sm" id="lg-sadd">Add supervisor</button></div>' +
      sect('Gear desk · only the Gear desk, no board', rows.filter(r => r.role === 'gear'), true) +
      '<div class="sb-inline-form" style="padding:0 8px"><input class="sb-field" id="lg-gname" placeholder="Gear manager name" style="flex:1 1 120px"><input class="sb-field" id="lg-gemail" type="email" placeholder="their Gmail" style="flex:1 1 180px"><button type="button" class="sb-zone-add" id="lg-gadd">Add gear manager</button></div>' +
      sect('Crew · see only their own shoots', rows.filter(r => r.role === 'crew'), false) +
      (noLogin.length ? '<p class="sb-modal-sub" style="padding:4px 8px">No Login Gmail yet (' + noLogin.length + '): ' + esc(noLogin.join(', ')) + '</p>' : '') +
      (last.error ? '<p class="sb-modal-sub" style="padding:4px 8px;color:#9a5b00">Last crew update failed: ' + esc(last.error) + '</p>' : '') +
      '</div><div class="sb-modal-foot"><button type="button" class="secondary" id="lg-sync">Update crew pages now</button><button type="button" id="lg-done">Done</button></div>';
    const modal = api.makeModal(html, true);
    modal.querySelector('#lg-done').addEventListener('click', () => { api.closeModal(); api.renderBoard(); });
    modal.querySelector('#lg-sync').addEventListener('click', async () => { known = null; await push(); openLogins(); });
    modal.querySelector('#lg-add').addEventListener('click', async () => {
      const email = modal.querySelector('#lg-email').value.trim().toLowerCase(), name = modal.querySelector('#lg-name').value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { api.toast('Type their Gmail address.'); return; }
      const ex = rows.find(r => r.email === email);
      if (ex && ex.role === 'owner') { api.toast('That is the admin login.'); return; }
      const { error: e } = await c.from('members').upsert({ email, role: 'manager', display_name: name || (ex && ex.display_name) || email, person_key: null });
      if (e) { api.toast('Could not add: ' + e.message); return; }
      api.toast((name || email) + ' can now sign in and edit the board.'); openLogins();
    });
    modal.querySelector('#lg-gadd').addEventListener('click', async () => {
      const email = modal.querySelector('#lg-gemail').value.trim().toLowerCase(), name = modal.querySelector('#lg-gname').value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { api.toast('Type their Gmail address.'); return; }
      const ex = rows.find(r => r.email === email);
      if (ex && ex.role === 'owner') { api.toast('That is the admin login.'); return; }
      const { error: e } = await c.from('members').upsert({ email, role: 'gear', display_name: name || (ex && ex.display_name) || email, person_key: null });
      if (e) { api.toast('Could not add: ' + (/check constraint/.test(e.message) ? 'run supabase/003_gear_desk.sql in Supabase first.' : e.message)); return; }
      api.toast((name || email) + ' can now sign in to the Gear desk.'); openLogins();
    });
    modal.querySelector('#lg-sadd').addEventListener('click', async () => {
      const email = modal.querySelector('#lg-semail').value.trim().toLowerCase(), name = modal.querySelector('#lg-sname').value.trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { api.toast('Type their Gmail address.'); return; }
      const ex = rows.find(r => r.email === email);
      if (ex && ex.role === 'owner') { api.toast('That is the admin login.'); return; }
      const { error: e } = await c.from('members').upsert({ email, role: 'supervisor', display_name: name || (ex && ex.display_name) || email, person_key: null });
      if (e) { api.toast('Could not add: ' + (/check constraint/.test(e.message) ? 'run supabase/012_supervisor.sql in Supabase first.' : e.message)); return; }
      api.toast((name || email) + ' can now sign in as supervisor.'); openLogins();
    });
    modal.querySelectorAll('.lg-rm').forEach(b => b.addEventListener('click', async () => {
      const { error: e } = await c.from('members').delete().eq('email', b.dataset.e);
      if (e) { api.toast('Could not remove: ' + e.message); return; }
      api.toast('Removed ' + b.dataset.e + '.'); known = null; push(); openLogins();
    }));
  }

  // owner: automatic backups kept on Cloudflare (a second copy outside Supabase)
  async function callApi(path, method) {
    const c = await app.client(), s = await c.auth.getSession();
    const r = await fetch(path, { method: method || 'GET', headers: { Authorization: 'Bearer ' + (s.data.session && s.data.session.access_token) } });
    return r;
  }
  // a backup file → an Excel workbook: one tab per part; nested values written as text so nothing is lost
  function backupWorkbook(b) {
    const wb = XLSX.utils.book_new(), used = new Set();
    const cell = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v).slice(0, 32000) : typeof v === 'string' ? v.slice(0, 32000) : v;
    const add = (title, rows) => {
      let name = String(title).replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31), i = 2; while (used.has(name)) name = String(title).slice(0, 28) + ' ' + i++; used.add(name);
      const list = (rows || []).map(r => { const o = {}; Object.keys(r || {}).forEach(k => { o[k] = cell(r[k]); }); return o; });
      XLSX.utils.book_append_sheet(wb, list.length ? XLSX.utils.json_to_sheet(list) : XLSX.utils.aoa_to_sheet([['(empty)']]), name);
    };
    add('About', [{ saved: b.savedAt, source: b.source, note: 'Muto\'s backup. Each tab is one part of the app. Long or nested values are written as text.' }].concat(Object.entries(b.studio_errors || {}).map(([t, e]) => ({ saved: 'NOT READ: ' + t, source: e, note: '' }))));
    add('Shoots', b.events); add('Shooters', b.shooters); add('Assistants', b.assistants); add('Gear', b.equipment); add('Days off', b.unavailability); add('Seasons', b.seasons);
    const app = b.app || {}; add('Logins', app.members); add('Crew days off', app.crew_away); add('Crew answers', app.crew_status); add('Gear log', app.gear_log);
    Object.entries(b.studio || {}).forEach(([t, rows]) => add(t.replace(/_/g, ' '), rows));
    add('History', b.history);
    return wb;
  }
  window.MUTOS_BACKUP_XLSX = backupWorkbook; // used by tests/backup.test.mjs
  async function openBackups() {
    if (!api) return;
    const esc = api.escapeHtml;
    let list = [], err = '';
    try { const r = await callApi('/api/backups'); const j = await r.json(); if (r.ok) list = j.backups; else err = j.error || ('error ' + r.status); } catch (e) { err = 'No connection.'; }
    const label = n => n.startsWith('nightly/') ? 'Nightly' : n.startsWith('monthly/') ? 'Monthly (kept for good)' : 'Made by hand';
    const when = b => b.at ? new Date(b.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : b.name;
    const kb = n => n ? (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1000)) + ' KB') : '';
    const html = api.modalHead('Backups', 'Everything is copied every night at 3 am to Cloudflare, a different company from the database: the board, crew, attendance and salaries, people, work, drives, cards, clients, packages and payments. The last 30 nights are kept, plus one per month for good. Excel opens in any spreadsheet app, without this app. To restore the board: Download, then Load backup at the top of the board.') +
      '<div class="sb-modal-list">' + (err ? '<p class="sb-modal-sub" style="padding:8px;color:#9a5b00">' + esc(err) + '</p>' : '') +
      (list.length ? list.map(b => '<div class="sb-manage-row" style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap"><span><b>' + esc(when(b)) + '</b><br><span class="sb-manage-sub">' + esc([label(b.name), b.shoots != null ? b.shoots + ' shoots' : '', b.rows != null ? b.rows + ' studio records' : 'board only (older copy)', kb(b.bytes)].filter(Boolean).join(' · ')) + '</span>' + (b.errors ? '<br><span class="sb-manage-sub" style="color:#9a5b00">' + b.errors + ' table(s) could not be read: see the file</span>' : '') + '</span><span style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="sb-btn-sm bk-xl" data-n="' + esc(b.name) + '">Excel</button><button type="button" class="sb-btn-sm secondary bk-dl" data-n="' + esc(b.name) + '">Download</button>' + (b.photos ? '<button type="button" class="sb-btn-sm secondary bk-dl" data-n="photos/' + esc(b.name) + '">Photos</button>' : '') + '</span></div>').join('')
        : (err ? '' : '<p class="sb-modal-empty">No backups yet. The first one is made tonight at 3 am, or tap "Back up now".</p>')) +
      '</div><div class="sb-modal-foot"><button type="button" class="secondary" id="bk-now">Back up now</button><button type="button" id="bk-done">Done</button></div>';
    const modal = api.makeModal(html, true);
    modal.querySelector('#bk-done').addEventListener('click', () => { api.closeModal(); api.renderBoard(); });
    modal.querySelector('#bk-now').addEventListener('click', async e => {
      e.target.disabled = true; e.target.textContent = 'Backing up…';
      const r = await callApi('/api/backups/now', 'POST').catch(() => null); const j = r ? await r.json().catch(() => ({})) : {};
      if (r && r.ok) { api.toast('Backup saved: ' + j.shoots + ' shoots.'); openBackups(); } else { api.toast('Backup failed: ' + (j.error || 'no connection')); e.target.disabled = false; e.target.textContent = 'Back up now'; }
    });
    const saveBlob = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); };
    modal.querySelectorAll('.bk-dl').forEach(btn => btn.addEventListener('click', async () => {
      const r = await callApi('/api/backups/file?name=' + encodeURIComponent(btn.dataset.n)).catch(() => null);
      if (!r || !r.ok) { api.toast('Download failed.'); return; }
      saveBlob(await r.blob(), 'mutos-backup-' + btn.dataset.n.replace(/\//g, '-') + '.json');
    }));
    // the same copy as one Excel file: a tab per part (shoots, crew, gear, attendance, people, drives, cards, clients, payments…)
    modal.querySelectorAll('.bk-xl').forEach(btn => btn.addEventListener('click', async () => {
      if (typeof XLSX === 'undefined') { api.toast('The spreadsheet maker did not load. Reload the page and try again.'); return; }
      btn.disabled = true; btn.textContent = 'Making…';
      try {
        const r = await callApi('/api/backups/file?name=' + encodeURIComponent(btn.dataset.n));
        if (!r.ok) throw new Error('download failed');
        const wb = backupWorkbook(await r.json());
        saveBlob(new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'mutos-backup-' + btn.dataset.n.replace(/\//g, '-') + '.xlsx');
      } catch (e) { api.toast('Could not make the Excel file: ' + (e.message || e)); }
      btn.disabled = false; btn.textContent = 'Excel';
    }));
  }

  window.MUTOS_APP = {
    attach(a) { const first = !api; api = a; window.__boardApi = a; if (first) { push(); setInterval(push, 10 * 60 * 1000); } if (window.MUTOS_UPDATES && window.__mutosRole !== 'supervisor') window.MUTOS_UPDATES.attach(a); /* day-off approvals are not his */ if (window.MUTOS_CLIENTS) window.MUTOS_CLIENTS.attach(a); },
    changed() { clearTimeout(timer); timer = setTimeout(push, 3000); if (window.MUTOS_UPDATES && window.__mutosRole !== 'supervisor') window.MUTOS_UPDATES.changed(); if (window.MUTOS_CLIENTS) window.MUTOS_CLIENTS.changed(); },
    openLogins, openBackups, keysFor, groupCrew, crewGroups: () => (api ? wanted() : new Map()),
    _push: push, _last: () => last
  };
})();
