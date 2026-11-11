// Muto's app · "Waiting for you to accept": cards and drives given to me (or returned to the office, for whoever accepts those).
// Shown at the top of Home (owner, manager, supervisor) and of the team home (me.html) until each handover is accepted or
// marked "not received" (Ravi, 11 Nov 2026). Accept or decline right here; the giver's phone is told (cards).
// MutosInbox.mount(el, { c, email, staff, personId, keeper, drivesHref, onChange })
(function () {
  const esc = s => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const ago = ts => { const m = Math.max(0, Math.round((Date.now() - new Date(ts)) / 60000)); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' day' + (m >= 2880 ? 's' : '') + ' ago'; };
  const list = (a, n = 6) => a.slice(0, n).join(', ') + (a.length > n ? ' +' + (a.length - n) : '');
  const CSS = '.ibx{display:flex;flex-direction:column;gap:10px;margin:14px 0 0}.ibx:empty{display:none}' +
    '.ibx-i{background:var(--honey,#f2dfa7);color:var(--ink,#2a1e22);border-radius:20px;padding:14px 16px;box-shadow:var(--shadow);animation:ibx-in .35s ease-out}' +
    '.ibx-i b{display:block;font-size:15px;line-height:1.3}.ibx-i small{display:block;font-size:12.5px;opacity:.8;margin-top:3px}' +
    '.ibx-a{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.ibx-a button{min-height:40px;border-radius:999px;border:0;font:600 14px var(--font-body,inherit);cursor:pointer}' +
    '.ibx-a .y{background:var(--ink,#2a1e22);color:#fff}.ibx-a .n{background:rgba(255,255,255,.7);color:var(--ink,#2a1e22)}.ibx-i a{color:inherit;font-size:12.5px}' +
    '@keyframes ibx-in{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:none}}';

  function mount(el, o) {
    if (!document.getElementById('ibx-css')) { const s = document.createElement('style'); s.id = 'ibx-css'; s.textContent = CSS; document.head.appendChild(s); }
    el.classList.add('ibx');
    const c = o.c; let groups = [], busy = false, names = {};
    const nameOf = id => id ? (names[id] || 'someone') : 'the office';
    async function q(p) { try { const r = await p; return r && !r.error ? r.data || [] : []; } catch (e) { return []; } }
    async function load() {
      const me = o.personId, out = [];
      const [cm, dm, dir] = await Promise.all([q(c.from('card_moves').select('*').eq('status', 'pending')), q(c.from('drive_moves').select('*').eq('status', 'pending')), q(c.rpc('people_directory'))]);
      dir.forEach(p => { names[p.id] = p.name; });
      const mineC = cm.filter(m => (m.to_person && m.to_person === me) || (!m.to_person && o.staff));
      const mineD = dm.filter(m => (m.to_person && m.to_person === me) || (!m.to_person && (o.staff || o.keeper)));
      const cards = mineC.length ? await q(c.from('cards').select('id, code').in('id', [...new Set(mineC.map(m => m.card))])) : [];
      const drives = mineD.length ? await q(c.from('drives').select('id, name').in('id', [...new Set(mineD.map(m => m.drive))])) : [];
      const by = new Map();
      mineC.forEach(m => { if (!by.has(m.batch)) by.set(m.batch, []); by.get(m.batch).push(m); });
      by.forEach(ms => { const m = ms[0]; out.push({ kind: 'card', ids: ms.map(x => x.id), office: !m.to_person, from: m.from_person, by: m.given_by_person, note: m.note, at: m.given_at, what: ms.map(x => (cards.find(k => k.id === x.card) || { code: '?' }).code).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) }); });
      mineD.forEach(m => out.push({ kind: 'drive', ids: [m.id], office: !m.to_person, from: m.from_person, by: m.given_by_person, note: m.note, at: m.given_at, what: [(drives.find(d => d.id === m.drive) || { name: 'a drive' }).name] }));
      groups = out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    }
    function render() {
      el.innerHTML = groups.map((g, i) => {
        const n = g.what.length, noun = g.kind === 'card' ? (n > 1 ? n + ' cards' : 'Card') : 'Drive';
        const head = (g.office ? noun + ' returned to the office' : noun + ' for you') + ': ' + list(g.what);
        const from = 'From ' + nameOf(g.from) + (g.by && g.by !== g.from ? ', given by ' + nameOf(g.by) : '') + ' · ' + ago(g.at) + (g.note ? ' · ' + g.note : '');
        return '<div class="ibx-i" data-ibx="' + i + '" role="status"><b>📥 ' + esc(head) + '</b><small>' + esc(from) + '</small>' +
          '<div class="ibx-a"><button type="button" class="n" data-no="' + i + '">Not received</button><button type="button" class="y" data-yes="' + i + '">I have ' + (n > 1 ? 'all ' + n : 'it') + ' ✓</button></div>' +
          '<small style="margin-top:8px"><a href="' + (g.kind === 'card' ? '/cards.html' : esc(o.drivesHref || '/mywork.html?tab=drives')) + '">Open ' + (g.kind === 'card' ? 'Cards' : 'Drives') + '</a></small></div>';
      }).join('');
      el.querySelectorAll('[data-yes]').forEach(b => b.addEventListener('click', () => answer(groups[+b.dataset.yes], true)));
      el.querySelectorAll('[data-no]').forEach(b => b.addEventListener('click', () => answer(groups[+b.dataset.no], false)));
      if (o.onChange) o.onChange(groups.length);
    }
    async function answer(g, yes) {
      if (!g || busy) return; busy = true;
      try {
        let res;
        if (g.kind === 'card') res = await c.rpc('card_answer', { p_moves: g.ids, p_accept: yes });
        else res = await c.rpc('drive_answer', { p_move: g.ids[0], p_accept: yes });
        const err = (res && res.error && res.error.message) || (res && res.data && res.data.error);
        if (err) { if (o.toast) o.toast(err, true); }
        else {
          if (o.toast) o.toast(yes ? (g.kind === 'card' ? (g.what.length > 1 ? 'Accepted. The cards are' : 'Accepted. The card is') : 'Accepted. The drive is') + ' now your responsibility.' : 'Marked as not received. The giver still has ' + (g.what.length > 1 ? 'them.' : 'it.'));
          if (g.kind === 'card') notify({ kind: 'answer', moves: g.ids });
        }
      } finally { busy = false; await refresh(); }
    }
    async function notify(body) {
      try { const s = await c.auth.getSession(); const tok = s && s.data && s.data.session && s.data.session.access_token; if (tok) fetch('/api/notify-card', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) }).catch(() => {}); } catch (e) {}
    }
    async function refresh() { await load(); render(); }
    let t = null; const soon = () => { clearTimeout(t); t = setTimeout(() => { if (!busy) refresh().catch(() => {}); }, 600); };
    try { c.channel('inbox-' + Math.random().toString(36).slice(2)).on('postgres_changes', { event: '*', schema: 'public', table: 'card_moves' }, soon).on('postgres_changes', { event: '*', schema: 'public', table: 'drive_moves' }, soon).subscribe(); } catch (e) {}
    document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });
    setInterval(() => { if (!document.hidden) soon(); }, 60000);
    refresh().catch(() => {});
    return { refresh, count: () => groups.length };
  }
  window.MutosInbox = { mount };
})();
