// Muto's app · shared bits of the Work desk (desk.html, for the owner and partner) and My work (mywork.html, for editors).
(function () {
  const KINDS = [
    ['reel', 'Reel', 'video'], ['teaser', 'Teaser', 'video'], ['trailer', 'Trailer', 'video'], ['highlight', 'Highlight film', 'video'], ['full', 'Full film', 'video'],
    ['top', 'Top selection', 'photo'], ['lr', 'LR edit', 'photo'], ['album_sel', 'Album selection', 'photo'], ['album', 'Album design', 'album'], ['other', 'Other', 'other']
  ];
  const KIND = Object.fromEntries(KINDS.map(([k, label, group]) => [k, { label, group }]));
  // label, background, text colour
  const STATUS = {
    todo: ['Not started', 'var(--sand)', 'var(--ink)'], editing: ['Editing', 'var(--lilac)', 'var(--ink)'], rendered: ['Rendered', 'var(--honey)', 'var(--warn-ink)'],
    sent: ['Sent to client', 'var(--blush)', 'var(--ink)'], changes: ['Changes asked', 'var(--no-bg)', 'var(--no-ink)'], final: ['Final ✓', 'var(--ok-bg)', 'var(--ok-ink)'], paused: ['Paused', '#eee', 'var(--muted)']
  };
  const OPEN = ['todo', 'editing', 'rendered', 'sent', 'changes'];
  const SKILLS = [['video', 'Video edit'], ['photo', 'Photo edit'], ['album', 'Album design'], ['data', 'Data copy']];
  const esc = s => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const pad = n => String(n).padStart(2, '0');
  const todayIST = () => { const d = new Date(Date.now() + 330 * 60000); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); };
  const istDate = ts => ts ? new Date(new Date(ts).getTime() + 330 * 60000).toISOString().slice(0, 10) : ''; // a timestamp's day in India
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dayShort = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '';
  const dayLong = s => s ? new Date(s + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const isPhoto = k => KIND[k] && KIND[k].group === 'photo';
  const kindLabel = k => (KIND[k] || { label: k }).label;
  const pill = st => { const s = STATUS[st] || [st, '#fff', '#000']; return '<span class="pill" style="background:' + s[1] + ';color:' + s[2] + '">' + esc(s[0]) + '</span>'; };
  const overdue = j => j.due && OPEN.includes(j.status) && j.status !== 'sent' && j.due < todayIST();
  const jobName = j => kindLabel(j.kind) + (j.title ? ': ' + j.title : '') + (j.fn_label ? ' · ' + j.fn_label : '');
  function progressText(j) {
    if (isPhoto(j.kind)) return (j.count_done || 0) + (j.count_total ? ' of ' + j.count_total : '') + ' photos';
    return (j.progress || 0) + '%';
  }
  function bar(j) {
    const p = isPhoto(j.kind) ? (j.count_total ? Math.min(100, Math.round(100 * (j.count_done || 0) / j.count_total)) : (j.count_done ? 50 : 0)) : (j.progress || 0);
    return '<div class="wbar" title="' + esc(progressText(j)) + '"><i style="width:' + (j.status === 'final' ? 100 : p) + '%"></i></div>';
  }
  // board shoots (collection "events") → weddings, grouped like the Clients window (wedding name, else phone, else shoot name)
  const norm = s => String(s || '').trim().toLowerCase();
  const digits = p => { let d = String(p || '').replace(/\D/g, ''); if (d.length === 10) d = '91' + d; if (d.length === 11 && d[0] === '0') d = '91' + d.slice(1); return d; };
  async function loadDocs(c, collection) {
    const out = [];
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await c.from('docs').select('id, data').eq('collection', collection).range(from, from + 999);
      if (error) throw error;
      (data || []).forEach(r => out.push(Object.assign({}, r.data, { id: r.id })));
      if (!data || data.length < 1000) break;
    }
    return out;
  }
  function weddingsFrom(events) {
    const by = new Map();
    events.forEach(ev => {
      if (ev.status === 'cancelled' || !ev.date) return;
      const key = ev.wedding ? 'w:' + norm(ev.wedding) : ev.contactPhone ? 'p:' + digits(ev.contactPhone) : 'n:' + norm(ev.name);
      if (!by.has(key)) by.set(key, { key, title: ev.wedding || ev.contactName || ev.name, events: [] });
      by.get(key).events.push(ev);
    });
    return [...by.values()].map(w => { w.events.sort((a, b) => a.date.localeCompare(b.date)); w.first = w.events[0].date; w.last = w.events[w.events.length - 1].date; return w; });
  }
  // a short name for a function: "Akriti Mehndi" in the wedding "Akriti" → "Mehndi"
  function fnName(ev, w) {
    const n = String(ev.name || '').trim(), t = String((w && w.title) || '').trim();
    return t && n.toLowerCase().startsWith(t.toLowerCase() + ' ') ? n.slice(t.length + 1) : n;
  }
  function sheet(html) {
    const bg = document.createElement('div'); bg.className = 'sheet-bg';
    bg.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', e => { if (e.target === bg) bg.remove(); });
    return bg;
  }
  window.MutosWork = { KINDS, KIND, STATUS, OPEN, SKILLS, esc, todayIST, istDate, addDays, dayShort, dayLong, isPhoto, kindLabel, pill, overdue, jobName, progressText, bar, loadDocs, weddingsFrom, fnName, sheet, digits };
})();
