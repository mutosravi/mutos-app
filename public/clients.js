// Muto's app, owner and managers: the Clients window. One secret link per wedding; the family fills each function's
// time, venue, address, contact and notes (public/client.html). The board keeps their function list up to date (client_feed).
(function () {
  const app = window.mutosApp;
  let api = null, links = [], itin = [], lastSig = new Map();
  const esc = s => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const digits = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1); return d; };
  const linkOf = l => location.origin + '/client.html?k=' + l.token;
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
  function summary() { if (!api) return null; const ws = weddings(); return { toCheck: ws.filter(w => stateOf(w).fresh).length, noLink: ws.filter(w => !stateOf(w).l).length }; }

  async function open() {
    if (!api) { alert('The board is still loading.'); return; }
    try { await load(); } catch (e) { api.toast('Could not load clients: ' + (e.message || e) + '. Run supabase/004_studio.sql first.'); return; }
    sync();
    const ws = weddings();
    const html = '<div class="sb-modal-list">' + (ws.length ? ws.map(w => {
      const s = stateOf(w);
      return '<div class="sb-manage-row" style="display:block;padding:10px 8px"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><b style="font-size:14px">' + esc(w.title) + '</b><br><span class="sb-manage-sub">' + esc(dayName(w.first) + (w.last !== w.first ? ' – ' + dayName(w.last) : '') + ' · ' + w.events.length + ' function' + (w.events.length > 1 ? 's' : '') + (w.phone ? ' · ' + w.phone : '')) + '</span></div>' +
        '<span class="pill ' + s.cls + '" style="font-size:11px;white-space:nowrap">' + esc(s.label) + '</span></div><div class="sb-btn-row" style="margin-top:8px">' +
        (s.l ? '<a class="sb-btn-sm wa" data-wa="' + esc(w.key) + '" href="#">WhatsApp link</a><button type="button" class="sb-btn-sm secondary" data-copy="' + esc(w.key) + '">Copy link</button>' + (s.it && s.it.updated_at ? '<button type="button" class="sb-btn-sm" data-see="' + esc(w.key) + '">See answers</button>' : '')
          : '<button type="button" class="sb-btn-sm" data-make="' + esc(w.key) + '">Make link</button>') + '</div></div>';
    }).join('') : '<p class="sb-modal-empty">No upcoming weddings on the board.</p>') + '</div>';
    const modal = api.makeModal(api.modalHead('Clients', 'Each family gets one link to fill time, venue, address and contact for every function. No login needed; the link works only for their wedding.') + html + '<div class="sb-modal-foot"><button type="button" id="cl-done">Done</button></div>', true);
    modal.querySelector('#cl-done').addEventListener('click', api.closeModal);
    const byKey = k => ws.find(w => w.key === k);
    modal.querySelectorAll('[data-make]').forEach(b => b.addEventListener('click', async () => {
      const w = byKey(b.dataset.make); b.disabled = true;
      const c = await app.client();
      const { error } = await c.from('client_links').insert({ wedding_key: w.key, title: w.title.slice(0, 120), phone: w.phone || null });
      if (error) { api.toast('Could not make the link: ' + error.message); b.disabled = false; return; }
      await load(); lastSig.delete(w.key); await sync(); open();
    }));
    modal.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
      const l = links.find(x => x.wedding_key === b.dataset.copy);
      try { await navigator.clipboard.writeText(linkOf(l)); api.toast('Link copied.'); } catch (e) { prompt('Copy this link:', linkOf(l)); }
    }));
    modal.querySelectorAll('[data-wa]').forEach(a => {
      const w = byKey(a.dataset.wa), l = links.find(x => x.wedding_key === w.key);
      const msg = 'Namaste! This is Muto\'s. For ' + w.title + ', please fill in the details of each function (start time, venue, address and a contact person at the venue) so our team reaches on time:\n' + linkOf(l) + '\n\nIt takes about 5 minutes and you can change it any time. Thank you!';
      a.href = 'https://wa.me/' + (digits(w.phone) || '') + '?text=' + encodeURIComponent(msg); a.target = '_blank'; a.rel = 'noopener';
    });
    modal.querySelectorAll('[data-see]').forEach(b => b.addEventListener('click', () => answers(byKey(b.dataset.see))));
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
    open, summary, _weddings: () => weddings(), _sync: sync, _load: load
  };
})();
