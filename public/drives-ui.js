// Muto's app · Drive register screens, shared by the Work desk (desk.html) and My work (mywork.html).
// MutosDrives.mount(el, opts) draws the list + search; tapping a drive opens its sheet (details, what is on it, give → accept, history).
// opts: { c, me (my person id or null), staff, owner, keeper, toast(msg, bad), weddings: [{ key, title }] }
(function () {
  const W = window.MutosWork, esc = W.esc;
  const WHAT = [['raw', 'Raw'], ['project', 'Project'], ['render', 'Render'], ['final', 'Final output'], ['backup', 'Backup copy'], ['other', 'Other']];
  const whatLabel = k => (WHAT.find(x => x[0] === k) || [k, k])[1];
  const STATUS = { in_use: 'In use', delivered: 'Delivered to client', faulty: 'Faulty', retired: 'Retired' };
  // sizes typed as "600 GB", "1.2 TB", "800MB" → GB (for the storage bar); folder view (028, 18 Nov 2026)
  const gbOf = t => { const m = String(t || '').replace(',', '.').match(/([\d.]+)\s*(tb|gb|mb|t|g|m)?/i); if (!m) return 0; const v = parseFloat(m[1]) || 0, u = (m[2] || 'gb').toLowerCase()[0]; return u === 't' ? v * 1000 : u === 'm' ? v / 1000 : v; };
  const gbText = g => g >= 1000 ? (Math.round(g / 100) / 10) + ' TB' : Math.round(g) + ' GB';
  const when = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '';

  function mount(el, opts) {
    const c = opts.c, toast = opts.toast;
    let drives = [], items = [], moves = [], dir = [], copies = [], cardsAll = [], view = 'all', q = '';
    // a folder = one line of the register: its file count (typed, or from the card copy), the cards whose footage is in it, its other copies
    const filesOf = it => it.files != null ? it.files : (copies.filter(x => (x.items || []).includes(it.id)).reduce((n, x) => n + (x.files || 0), 0) || null);
    const cardsIn = it => { const ids = new Set(copies.filter(x => (x.items || []).includes(it.id) || (it.from_item && (x.items || []).includes(it.from_item))).map(x => x.card)); return cardsAll.filter(k => ids.has(k.id)); };
    const copiesOf = it => items.filter(x => x.id !== it.id && x.drive !== it.drive && (x.from_item === it.id || (it.from_item && (x.id === it.from_item || x.from_item === it.from_item)) || (x.title === it.title && x.wedding_key === it.wedding_key)));
    const clientOf = it => { const w = (opts.weddings || []).find(x => x.key === it.wedding_key); return w ? w.title : String(it.title).split(' · ')[0].trim(); };
    const nameOf = id => id ? ((dir.find(p => p.id === id) || {}).name || 'someone') : 'the office';
    const holderText = d => d.status === 'delivered' ? 'Delivered to client' : d.holder ? 'With ' + nameOf(d.holder) : 'In the office';
    const pendingOf = d => moves.find(m => m.drive === d.id && m.status === 'pending');
    const forMe = m => m.status === 'pending' && ((m.to_person && m.to_person === opts.me) || (!m.to_person && (opts.keeper || opts.staff)));
    const canGive = d => d.status === 'in_use' && (opts.staff || (d.holder && d.holder === opts.me) || (!d.holder && opts.keeper));
    // drive details: only the studio (owner, manager). Data on a drive: the studio or whoever has it.
    // A drive keeper only hands over and receives (Ravi, 11 Nov 2026; 016_keeper_handover_only.sql)
    const canEdit = d => opts.staff || (d.holder && d.holder === opts.me);

    const pageAll = async mk => { const out = []; for (let from = 0; from < 200000; from += 1000) { const r = await mk().order('id').range(from, from + 999); if (r.error) return from ? { data: out } : r; out.push(...(r.data || [])); if (!r.data || r.data.length < 1000) break; } return { data: out }; };   // Supabase sends at most 1000 rows per read
    async function load() {
      const [d, i, m, p, cc, ck] = await Promise.all([
        c.from('drives').select('*').order('name'),
        pageAll(() => c.from('drive_items').select('*').is('removed_at', null)),
        c.from('drive_moves').select('*').eq('status', 'pending'),
        c.rpc('people_directory'),
        pageAll(() => c.from('card_copies').select('id, card, cycle, backup, drive_name, items, files')),
        pageAll(() => c.from('cards').select('id, code, data, cycle'))
      ]);
      if (d.error) throw d.error;
      drives = d.data || []; items = i.error ? [] : (i.data || []); moves = m.error ? [] : (m.data || []); dir = p.error ? [] : (p.data || []);
      copies = cc.error ? [] : (cc.data || []); cardsAll = ck.error ? [] : (ck.data || []);
    }
    async function refresh() { await load(); render(); if (opts.onChange) opts.onChange(waiting()); }
    const waiting = () => moves.filter(forMe).length;

    function render() {
      const mine = drives.filter(d => d.holder && d.holder === opts.me);
      const VIEWS = [['all', 'All'], opts.me ? ['mine', 'With me (' + mine.length + ')'] : null, ['studio', 'Studio'], ['client', 'Client drives'], ['out', 'With someone'], ['waiting', 'Being handed over'], ['delivered', 'Delivered']].filter(Boolean);
      const inView = d => ({ all: d.status !== 'delivered' && d.status !== 'retired', mine: d.holder && d.holder === opts.me, studio: d.owner_type === 'studio' && d.status !== 'retired', client: d.owner_type === 'client' && d.status !== 'delivered',
        out: !!d.holder, waiting: !!pendingOf(d), delivered: d.status === 'delivered' })[view];
      const s = q.trim().toLowerCase();
      const hitItems = s.length > 1 ? items.filter(it => (it.title + ' ' + (it.note || '')).toLowerCase().includes(s)) : [];
      const list = drives.filter(d => (s ? (d.name + ' ' + (d.client_name || '') + ' ' + (d.model || '') + ' ' + (d.notes || '')).toLowerCase().includes(s) || hitItems.some(it => it.drive === d.id) : inView(d)));
      const inbox = moves.filter(forMe);
      el.innerHTML =
        (inbox.length ? '<div class="sechead" style="margin-top:10px"><h2>Waiting for you to accept</h2></div>' + inbox.map(m => { const d = drives.find(x => x.id === m.drive) || { name: '?' }; return '<div class="card"><div class="row2"><div><b>' + esc(d.name) + '</b><div class="meta">From ' + esc(nameOf(m.from_person)) + (m.given_by_person && m.given_by_person !== m.from_person ? ', given by ' + esc(nameOf(m.given_by_person)) : '') + (m.to_person ? '' : ' → back to the office') + ' · ' + esc(when(m.given_at)) + (m.note ? ' · ' + esc(m.note) : '') + '</div></div></div><div class="pillrow" style="margin-top:8px"><button type="button" class="pillbtn light" data-no="' + m.id + '">Not received</button><button type="button" class="pillbtn" data-yes="' + m.id + '">I have it ✓</button></div></div>'; }).join('') : '') +
        '<div class="tools"><input class="in" type="search" id="dq" placeholder="Find a drive or a wedding (e.g. Jyoti)" value="' + esc(q) + '" style="flex:1 1 220px">' + (opts.staff ? '<button type="button" class="pillbtn" id="dadd" style="min-height:40px">＋ Add drive</button>' : '') + '</div>' +
        (s ? '' : '<div class="chips" style="margin:6px 0">' + VIEWS.map(([k, l]) => '<button type="button" class="chip-b' + (view === k ? ' on' : '') + '" data-dv="' + k + '">' + esc(l) + '</button>').join('') + '</div>') +
        (hitItems.length ? '<div class="sechead"><h2>Data found</h2></div>' + hitItems.slice(0, 30).map(it => { const d = drives.find(x => x.id === it.drive) || {}; return '<button type="button" class="card jrow" data-d="' + esc(d.id) + '" style="border-top:0;padding:10px 14px"><span class="nm">' + esc(it.title) + ' · ' + esc(whatLabel(it.what)) + '</span><span class="meta" style="grid-column:auto">on <b>' + esc(d.name || '?') + '</b></span><span class="meta">' + esc(holderText(d)) + (it.size_label ? ' · ' + esc(it.size_label) : '') + '</span></button>'; }).join('') + '<div class="sechead"><h2>Drives</h2></div>' : '') +
        (list.length ? list.map(d => {
          const n = items.filter(it => it.drive === d.id).length, pm = pendingOf(d);
          return '<button type="button" class="card jrow" data-d="' + d.id + '" style="border-top:0;padding:11px 14px"><span class="nm">' + esc(d.name) + (d.owner_type === 'client' ? ' <span class="pill mute">client</span>' : '') + '</span>' +
            '<span>' + (pm ? '<span class="pill wait">→ ' + esc(nameOf(pm.to_person)) + ', waiting</span>' : d.status !== 'in_use' ? '<span class="pill no">' + esc(STATUS[d.status]) + '</span>' : d.holder ? '<span class="pill ok">' + esc(nameOf(d.holder)) + '</span>' : '<span class="pill mute">Office</span>') + '</span>' +
            '<span class="meta">' + esc([[d.size_label, d.kind].filter(Boolean).join(' '), d.model, d.free_label ? d.free_label + ' free' : '', d.cleaned_on ? 'cleaned ' + W.dayShort(d.cleaned_on) : '', n ? n + ' item' + (n > 1 ? 's' : '') : 'nothing listed yet', d.client_name && d.client_name !== d.name ? d.client_name : ''].filter(Boolean).join(' · ')) + '</span></button>';
        }).join('') : '<div class="empty">' + (drives.length ? 'No drives here.' : 'No drives yet.' + (opts.staff ? ' Run the drive import or tap ＋ Add drive.' : '')) + '</div>');
      el.querySelectorAll('[data-dv]').forEach(b => b.addEventListener('click', () => { view = b.dataset.dv; render(); }));
      const dq = el.querySelector('#dq'); dq.addEventListener('input', () => { q = dq.value; clearTimeout(render.t); render.t = setTimeout(() => { render(); const x = el.querySelector('#dq'); x.focus(); x.setSelectionRange(x.value.length, x.value.length); }, 300); });
      const add = el.querySelector('#dadd'); if (add) add.addEventListener('click', () => editDrive(null));
      el.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', () => openDrive(drives.find(d => d.id === b.dataset.d))));
      el.querySelectorAll('[data-yes]').forEach(b => b.addEventListener('click', () => answer(b.dataset.yes, true)));
      el.querySelectorAll('[data-no]').forEach(b => b.addEventListener('click', () => answer(b.dataset.no, false)));
    }
    async function rpc(fn, args, ok) {
      const { data, error } = await c.rpc(fn, args);
      if (error || !data || data.error) { toast((data && data.error) || (error && error.message) || 'Could not save.', true); return null; }
      if (ok) toast(ok); return data;
    }
    async function answer(id, yes) { if (await rpc('drive_answer', { p_move: id, p_accept: yes }, yes ? 'Accepted. The drive is now your responsibility.' : 'Marked as not received. The giver still has it.')) { document.querySelectorAll('.sheet-bg').forEach(x => x.remove()); await refresh(); } }
    async function notify(id) {
      try { const s = await c.auth.getSession(); const tok = s && s.data && s.data.session && s.data.session.access_token; if (tok) fetch('/api/notify-drive', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify({ id }) }).catch(() => {}); } catch (e) {}
    }

    async function openDrive(d, startPath) {
      if (!d) return;
      const its = items.filter(it => it.drive === d.id), pm = pendingOf(d);
      const bg = W.sheet('<h3>' + esc(d.name) + '</h3><p class="sub" style="margin:-4px 0 8px">' + esc([[d.size_label, d.kind].filter(Boolean).join(' '), d.model, d.format, d.owner_type === 'client' ? 'client drive' + (d.client_name && d.client_name !== d.name ? ': ' + d.client_name : '') : 'studio drive'].filter(Boolean).join(' · ')) + '</p>' +
        '<div class="ans ' + (pm ? 'wait' : d.status !== 'in_use' ? 'no' : 'ok') + '" style="margin:0 0 10px"><b>' + esc(holderText(d)) + '</b>' + (pm ? ' · given to ' + esc(nameOf(pm.to_person)) + ', waiting for them to accept' + (pm.note ? ' (' + esc(pm.note) + ')' : '') : '') + (d.free_label || d.cleaned_on ? '<br>' + esc([d.free_label ? d.free_label + ' free' : '', d.cleaned_on ? 'cleaned ' + W.dayLong(d.cleaned_on) : ''].filter(Boolean).join(' · ')) : '') + (d.notes ? '<br>' + esc(d.notes) : '') + '</div>' +
        '<div class="pillrow" style="margin-bottom:8px">' +
          (pm && forMe(pm) ? '<button type="button" class="pillbtn light" id="dno">Not received</button><button type="button" class="pillbtn" id="dyes">I have it ✓</button>'
            : (canGive(d) ? '<button type="button" class="pillbtn" id="dgive">' + (d.holder ? 'Give to someone' : 'Give out') + '</button>' : '') + (pm && (opts.staff || pm.given_by === opts.email) ? '<button type="button" class="pillbtn light" id="dcancel">Take back the handover</button>' : opts.staff ? '<button type="button" class="pillbtn light" id="dedit">Edit details</button>' : '')) + '</div>' +
        '<div id="dtree"></div>' +
        (canEdit(d) ? '<div id="addbox"><div class="form-grid" style="margin-top:8px"><label class="wide">Folder<input class="in" id="it-p" list="dl-path" maxlength="200" placeholder="e.g. Jyoti/Haldi/Candid"></label><label class="wide">Wedding or event<input class="in" id="it-t" list="dl-wed" maxlength="160" placeholder="e.g. Jyoti & Amit · Haldi"></label>' +
          '<label>What<select class="in" id="it-w">' + WHAT.map(([k, l]) => '<option value="' + k + '">' + l + '</option>').join('') + '</select></label><label>Size<input class="in" id="it-s" maxlength="20" placeholder="e.g. 600 GB"></label>' +
          '<label>Files<input class="in" id="it-f" type="number" min="0" inputmode="numeric" placeholder="e.g. 812"></label>' +
          '<label class="wide">Note<input class="in" id="it-n" maxlength="300" placeholder="optional"></label></div><button type="button" class="pillbtn light" id="it-add" style="width:100%">＋ Add to this drive</button></div>' : '') +
        (opts.staff && d.status === 'in_use' ? '<button type="button" class="pillbtn light" id="dclean" style="width:100%;margin-top:8px">Cleaned this drive</button>' : '') +
        (opts.owner ? '<p style="margin-top:10px"><button type="button" class="x" id="dfix">Correct where it is</button></p>' : '') +
        (opts.staff ? '<div id="dremoved"></div>' : '') +
        '<h4>History</h4><div id="dhist" class="sub">Loading…</div>' +
        '<div class="pillrow" style="margin-top:12px"><button type="button" class="pillbtn light" id="dclose">Close</button></div>' +
        '<datalist id="dl-wed">' + (opts.weddings || []).map(w => '<option value="' + esc(w.title) + '">').join('') + '</datalist>' +
        '<datalist id="dl-path">' + [...new Set(its.flatMap(it => { const segs = (it.path || '').split('/').filter(Boolean); return segs.map((x, i) => segs.slice(0, i + 1).join('/')); }))].sort().map(x => '<option value="' + esc(x) + '">').join('') + '</datalist>');
      const g = id => bg.querySelector(id), on = (id, f) => { const x = g(id); if (x) x.addEventListener('click', f); };
      on('#dclose', () => bg.remove());
      on('#dyes', () => answer(pm.id, true)); on('#dno', () => answer(pm.id, false));
      on('#dcancel', async () => { if (await rpc('drive_cancel', { p_move: pm.id }, 'Handover taken back.')) { bg.remove(); await refresh(); } });
      on('#dedit', () => { bg.remove(); editDrive(d); });
      on('#dgive', () => give(d, bg));
      on('#dfix', () => fix(d, bg));
      on('#dclean', () => clean(d, its, bg));
      on('#it-add', async () => {
        const t = g('#it-t').value.trim(); if (!t) { toast('Write the wedding or event.', true); return; }
        const w = (opts.weddings || []).find(x => x.title.toLowerCase() === t.toLowerCase().split(' · ')[0]);
        const fv = g('#it-f').value.trim(), row = { drive: d.id, title: t, path: (g('#it-p').value || '').trim() || null, what: g('#it-w').value, size_label: g('#it-s').value.trim() || null, note: g('#it-n').value.trim() || null, wedding_key: w ? w.key : null };
        if (fv) row.files = Math.max(0, Math.round(Number(fv)) || 0);
        const { error } = await c.from('drive_items').insert(row);
        if (error) { toast('Could not add: ' + error.message, true); return; }
        bg.remove(); await refresh(); toast('Added to ' + d.name + '.'); openDrive(drives.find(x => x.id === d.id));
      });
      drawTree(bg, d, its, startPath && its.some(it => under(it, startPath)) ? startPath : '');
      // removed lines (admin / manager): bring back one removed by mistake (023_drive_restore.sql)
      if (opts.staff) (async () => {
        const { data: all } = await pageAll(() => c.from('drive_items').select('*').eq('drive', d.id));
        const allGone = (all || []).filter(it => it.removed_at).sort((a, b) => String(b.removed_at).localeCompare(String(a.removed_at))), box = g('#dremoved');
        if (!box || !allGone.length) return;
        // lines marked deleted together (same moment, same reason, not moved) can come back together (drive_restore_lines, 033)
        const groups = new Map(); allGone.filter(it => !it.moved_to).forEach(it => { const k = it.removed_at + '|' + (it.removed_why || ''); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); });
        const together = [...groups.values()].filter(x => x.length > 1).slice(0, 10), inGroup = new Set(together.flat().map(it => it.id));
        const gone = allGone.filter(it => !inGroup.has(it.id)).slice(0, 30);
        box.innerHTML = '<details style="margin-top:6px"><summary class="sub" style="cursor:pointer">Removed from this drive (' + allGone.length + ')</summary>' +
          together.map((list, i) => '<div class="rep dgone-grp" style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span>📁 <b>' + esc([...new Set(list.map(it => (it.path || it.title)))].slice(0, 4).join(', ')) + '</b> · ' + list.length + ' items deleted together' +
            '<br><span class="meta" style="display:inline">' + esc(when(list[0].removed_at)) + (list[0].removed_why ? ' · ' + esc(list[0].removed_why) : '') + '</span></span><button type="button" class="chip" data-backall="' + i + '" style="flex:0 0 auto">Bring back all</button></div>').join('') +
          gone.map(it => '<div class="rep" style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span><b>' + esc(it.title) + '</b> · ' + esc(whatLabel(it.what)) +
          '<br><span class="meta" style="display:inline">removed ' + esc(when(it.removed_at)) + (it.removed_why ? ' · ' + esc(it.removed_why) : '') + '</span></span>' +
          (it.moved_to ? '<span class="meta" style="flex:0 0 auto">moved</span>' : '<button type="button" class="chip" data-back="' + it.id + '" style="flex:0 0 auto">Bring back</button>') + '</div>').join('') + '</details>';
        box.querySelectorAll('[data-backall]').forEach(b => b.addEventListener('click', async () => {
          const list = together[+b.dataset.backall], why = prompt('Why bring back these ' + list.length + ' items?', 'Removed by mistake'); if (!why) return;
          if (await rpc('drive_restore_lines', { p_drive: d.id, p_items: list.map(it => it.id), p_why: why }, list.length + ' items brought back.')) { bg.remove(); await refresh(); openDrive(drives.find(x => x.id === d.id)); }
        }));
        box.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', async () => {
          const why = prompt('Why bring it back?', 'Removed by mistake'); if (!why) return;
          if (await rpc('drive_item_restore', { p_item: b.dataset.back, p_why: why }, 'Brought back.')) { bg.remove(); await refresh(); openDrive(drives.find(x => x.id === d.id)); }
        }));
      })();
      const { data: log } = await c.from('drive_log').select('*').eq('drive', d.id).order('at', { ascending: false }).limit(40);
      const h = g('#dhist'); if (h) h.innerHTML = (log || []).length ? log.map(l => '<div class="rep"><span class="meta" style="display:inline">' + esc(when(l.at)) + '</span> · ' + esc(l.what) + '</div>').join('') : 'Nothing yet.';
    }

    // ---------- the drive like a Finder window (029): folders → subfolders → what is inside ----------
    // a line sits in its folder (path, e.g. "Sharma/Haldi/Candid"); older lines without one sit under the client's name
    const pathOf = it => it.path || clientOf(it) || 'Not in a folder';
    const under = (it, P) => !P || pathOf(it) === P || pathOf(it).startsWith(P + '/');
    const sumGb = list => list.reduce((n, it) => n + gbOf(it.size_label), 0), sumFiles = list => list.reduce((n, it) => n + (filesOf(it) || 0), 0);
    function backupBadge(list) {
      const raw = list.filter(it => it.what === 'raw'), safe = raw.filter(it => copiesOf(it).length || it.no_backup);
      if (!raw.length) return list.some(it => copiesOf(it).length) ? '<span class="pill ok">✓ copies</span>' : '';
      if (safe.length === raw.length && raw.every(it => it.no_backup && !copiesOf(it).length)) return '<span class="pill mute">no backup needed</span>';
      return safe.length === raw.length ? '<span class="pill ok">✓ backed up</span>' : safe.length ? '<span class="pill wait">' + (raw.length - safe.length) + ' without backup</span>' : '<span class="pill wait">no backup</span>';
    }
    function drawTree(bg, d, its, P) {
      const box = bg.querySelector('#dtree'); if (!box) return;
      const cap = gbOf(d.size_label), used = sumGb(its), sized = its.filter(it => it.size_label).length;
      const here = its.filter(it => under(it, P)), sub = new Map(), inside = [];
      here.forEach(it => { const rest = P ? pathOf(it).slice(P.length + 1) : pathOf(it); if (!rest) { inside.push(it); return; } const k = rest.split('/')[0]; if (!sub.has(k)) sub.set(k, []); sub.get(k).push(it); });
      const segs = P ? P.split('/') : [];
      const crumbs = '<div class="dcrumbs" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:8px 0 4px;padding:6px 0;font-size:14px;position:sticky;top:0;z-index:2;background:var(--card,#fff)">💽 <button type="button" class="x" data-cd="" style="font-weight:700">' + esc(d.name) + '</button>' +
        segs.map((x, i) => ' › <button type="button" class="x" data-cd="' + esc(segs.slice(0, i + 1).join('/')) + '"' + (i === segs.length - 1 ? ' style="font-weight:700;text-decoration:none"' : '') + '>' + esc(x) + '</button>').join('') + '</div>';
      const head = '<h4>On this drive · ' + its.length + ' item' + (its.length === 1 ? '' : 's') + '</h4>' + (its.length ? '<div class="meta" id="dstore">' + (cap ? gbText(used) + ' used of ' + gbText(cap) + ' · ' + gbText(Math.max(0, cap - used)) + ' free' : gbText(used) + ' listed') + (sized < its.length ? ' (' + (its.length - sized) + ' without a size)' : '') + '</div>' +
        (cap ? '<div style="margin:6px 0 2px;height:8px;border-radius:4px;background:var(--sand,#eee);overflow:hidden"><i style="display:block;height:100%;width:' + Math.min(100, Math.round(used / cap * 100)) + '%;background:' + (used / cap > 0.9 ? 'var(--no-ink,#b23a26)' : 'var(--rose,#9e4f62)') + '"></i></div>' : '') : '');
      const edit = canEdit(d), pick = key => edit ? '<input type="checkbox" class="dpick" data-pk="' + esc(key) + '" aria-label="Select" style="flex:0 0 auto;width:20px;height:20px;margin:0 2px 0 0">' : '';
      const wrap = (key, html) => edit ? '<div style="display:flex;align-items:center;gap:6px">' + pick(key) + '<div style="flex:1 1 auto;min-width:0">' + html + '</div></div>' : html;
      const folderRow = ([name, list]) => { const f = sumFiles(list), g = sumGb(list);
        return wrap('f:' + (P ? P + '/' + name : name), '<button type="button" class="rep dsub" data-cd="' + esc(P ? P + '/' + name : name) + '" style="display:flex;width:100%;text-align:left;justify-content:space-between;gap:8px;align-items:center;border:0;background:none;font:inherit;color:inherit;cursor:pointer;padding:9px 2px">' +
          '<span><span aria-hidden="true">📁</span> <b>' + esc(name) + '</b><br><span class="meta" style="display:inline">' + esc([list.length + ' item' + (list.length === 1 ? '' : 's'), f ? f + ' files' : '', g ? gbText(g) : ''].filter(Boolean).join(' · ')) + '</span></span><span style="flex:0 0 auto">' + backupBadge(list) + ' ›</span></button>'); };
      const itemRow = it => { const f = filesOf(it), cp = copiesOf(it);
        return wrap('i:' + it.id, '<button type="button" class="rep dfolder" data-fo="' + it.id + '" style="display:flex;width:100%;text-align:left;justify-content:space-between;gap:8px;align-items:center;border:0;background:none;font:inherit;color:inherit;cursor:pointer;padding:8px 2px">' +
          '<span><span aria-hidden="true">🗂</span> ' + esc(it.title) + '<br><span class="meta" style="display:inline">' + esc([whatLabel(it.what), f != null ? f + ' files' : '', it.size_label || ''].filter(Boolean).join(' · ')) + '</span></span>' +
          '<span style="flex:0 0 auto">' + (cp.length ? '<span class="pill ok">✓ ' + cp.length + ' more cop' + (cp.length > 1 ? 'ies' : 'y') + '</span>' : it.no_backup ? '<span class="pill mute">no backup needed</span>' : it.what === 'raw' ? '<span class="pill wait">no backup</span>' : '') + ' ›</span></button>'); };
      const others = drives.filter(x => x.id !== d.id && x.status === 'in_use');
      box.innerHTML = head + (its.length ? crumbs : '') +
        (!its.length ? '<p class="sub">Nothing listed yet.</p>' : !here.length ? '<p class="sub">This folder is empty.</p>' :
          [...sub.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en', { numeric: true })).map(folderRow).join('') + inside.sort((a, b) => a.title.localeCompare(b.title)).map(itemRow).join('')) +
        (P && opts.staff && here.length && others.length ? '<div class="card" style="margin-top:10px;padding:10px 12px"><b>Back up "' + esc(segs[segs.length - 1]) + '"</b><p class="sub" style="margin:2px 0 6px">Copy the folder in Finder first, then record it here: everything in it (' + here.length + ' item' + (here.length === 1 ? '' : 's') + ', ' + gbText(sumGb(here)) + ') is listed on that drive in the same folders, and the cards in it with one copy turn <b>Copied ✓</b>.</p>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap"><select class="in" id="tb-to" style="flex:1 1 180px"><option value="">Backed up to…</option>' + others.map(x => '<option value="' + x.id + '">' + esc(x.name + (x.size_label ? ' · ' + x.size_label : '')) + '</option>').join('') + '</select><button type="button" class="pillbtn" id="tb-go">Record the backup</button></div></div>' : '');
      // move / rename folders within this drive (030): tick folders or items, pick where they go
      if (edit && here.length) {
        const allFolders = [...new Set(its.flatMap(it => { const sg = pathOf(it).split('/'); return sg.map((x, i) => sg.slice(0, i + 1).join('/')); }))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
        box.insertAdjacentHTML('beforeend', '<div class="card" id="dmv" hidden style="margin-top:10px;padding:10px 12px;position:sticky;bottom:0;background:var(--card,#fff)"><b id="mv-n"></b>' +
          '<div class="form-grid" style="margin-top:6px"><label class="wide" id="mv-namebox" hidden>New name<input class="in" id="mv-name" maxlength="80" data-nosuggest></label>' +
          '<label class="wide">Move to (a folder on ' + esc(d.name) + ')<input class="in" id="mv-to" maxlength="200" list="dl-mvto" placeholder="Leave empty for the top of the drive" data-nosuggest><datalist id="dl-mvto">' + allFolders.map(x => '<option value="' + esc(x) + '">').join('') + '</datalist></label></div>' +
          '<div class="pillrow"><button type="button" class="pillbtn" id="mv-go">Move</button><button type="button" class="pillbtn light" id="del-go">🗑 Deleted from drive</button><button type="button" class="pillbtn light" id="mv-x">Cancel</button></div></div>');
        const bar = box.querySelector('#dmv'), picks = () => [...box.querySelectorAll('.dpick:checked')].map(x => x.dataset.pk);
        const show = () => { const pk = picks(), nf = pk.filter(k => k[0] === 'f').length, ni = pk.length - nf; bar.hidden = !pk.length; if (!pk.length) return;
          box.querySelector('#mv-n').textContent = [nf ? nf + ' folder' + (nf > 1 ? 's' : '') : '', ni ? ni + ' item' + (ni > 1 ? 's' : '') : ''].filter(Boolean).join(' and ') + ' selected';
          const one = pk.length === 1 && nf === 1, nb = box.querySelector('#mv-namebox'), wasHidden = nb.hidden; nb.hidden = !one;
          if (one && wasHidden) box.querySelector('#mv-name').value = pk[0].slice(2).split('/').pop();
          const to = box.querySelector('#mv-to'); if (!to.dataset.touched) to.value = P; };
        box.querySelector('#mv-to').addEventListener('input', e => { e.target.dataset.touched = '1'; });
        box.querySelectorAll('.dpick').forEach(x => x.addEventListener('change', show));
        box.querySelector('#mv-x').addEventListener('click', () => { box.querySelectorAll('.dpick:checked').forEach(x => { x.checked = false; }); show(); });
        // the picked folders (with their subfolders) and items were deleted from the real drive (033)
        box.querySelector('#del-go').addEventListener('click', () => {
          const pk = picks(), ids = new Set(), words = [];
          pk.filter(k => k[0] === 'f').forEach(k => { const S = k.slice(2); its.filter(it => under(it, S)).forEach(it => ids.add(it.id)); words.push(S); });
          pk.filter(k => k[0] === 'i').forEach(k => { const it = its.find(x => x.id === k.slice(2)); if (it && !ids.has(it.id)) { ids.add(it.id); words.push(it.title); } });
          if (ids.size) deleteLines(d, [...ids], words, bg, P);
        });
        box.querySelector('#mv-go').addEventListener('click', async () => {
          const pk = picks(), D = String(box.querySelector('#mv-to').value || '').split('/').map(x => x.trim()).filter(Boolean).join('/');
          const nameIn = box.querySelector('#mv-namebox').hidden ? '' : box.querySelector('#mv-name').value.trim();
          if (nameIn.includes('/')) { toast('A folder name cannot have "/" in it.', true); return; }
          const moves = new Map(), words = [];
          for (const k of pk.filter(k => k[0] === 'f')) {
            const S = k.slice(2), name = nameIn || S.split('/').pop(), base = (D ? D + '/' : '') + name;
            if (base === S) { toast(nameIn ? 'Type a new name or pick another place.' : name + ' is already there.', true); return; }
            if (D === S || D.startsWith(S + '/')) { toast('A folder cannot go inside itself (' + S + ').', true); return; }
            its.filter(it => under(it, S)).forEach(it => moves.set(it.id, base + pathOf(it).slice(S.length)));
            words.push(S.split('/').pop() + (nameIn && nameIn !== S.split('/').pop() ? ' (renamed ' + nameIn + ')' : ''));
          }
          for (const k of pk.filter(k => k[0] === 'i')) { const it = its.find(x => x.id === k.slice(2)); if (!it || moves.has(it.id)) continue;
            if (!D) { toast('Pick a folder for ' + it.title + ' (items need a folder).', true); return; }
            moves.set(it.id, D); words.push(it.title); }
          if (!moves.size) return;
          const r = await rpc('drive_set_paths', { p_drive: d.id, p_moves: [...moves].map(([id, path]) => ({ id, path })), p_label: 'Moved ' + words.join(', ') + ' to ' + (D || 'the top of ' + d.name) }); if (!r) return;
          toast(words.join(', ') + ' → ' + (D || 'top of ' + d.name) + ' (' + r.moved + ' item' + (r.moved === 1 ? '' : 's') + ').');
          bg.remove(); await refresh(); openDrive(drives.find(x => x.id === d.id), D);
        });
      }
      box.querySelectorAll('[data-cd]').forEach(b => b.addEventListener('click', () => drawTree(bg, d, its, b.dataset.cd)));
      box.querySelectorAll('[data-fo]').forEach(b => b.addEventListener('click', () => openFolder(items.find(it => it.id === b.dataset.fo), d, bg)));
      const ip = bg.querySelector('#it-p'); if (ip && !ip.dataset.touched) { ip.value = P; ip.addEventListener('input', () => { ip.dataset.touched = '1'; }, { once: true }); }
      const go = box.querySelector('#tb-go'); if (go) go.addEventListener('click', async () => {
        const to = box.querySelector('#tb-to').value; if (!to) { toast('Pick the drive it was backed up to.', true); return; }
        const r = await rpc('drive_backup_folder', { p_drive: d.id, p_path: P, p_to: to }); if (!r) return;
        const dn = (drives.find(x => x.id === to) || {}).name;
        toast(segs[segs.length - 1] + ' backed up to ' + dn + ' (' + r.lines + ' item' + (r.lines === 1 ? '' : 's') + (r.skipped ? ', ' + r.skipped + ' already there' : '') + ').' + (r.cards_copied ? ' ' + r.cards.join(', ') + (r.cards_copied > 1 ? ' are' : ' is') + ' now Copied ✓.' : ''));
        bg.remove(); await refresh(); openDrive(drives.find(x => x.id === d.id), P);
      });
    }
    function openFolder(it, d, parent) {
      if (!it) return;
      const f = filesOf(it), cp = copiesOf(it), ks = cardsIn(it), others = drives.filter(x => x.id !== d.id && x.status === 'in_use' && !cp.some(y => y.drive === x.id));
      const ST = { empty: ['ok', 'Free'], hold: ['no', 'Hold · not copied'], single: ['wait', 'Single copy'], copied: ['ok', 'Copied ✓'] };
      // where this line sits, like Finder's path bar: tap the drive or any folder to go there
      const segs = pathOf(it).split('/'), crumb = (label, P, last) => '<button type="button" class="x" data-go="' + esc(P) + '"' + (last ? ' style="font-weight:700"' : '') + '>' + esc(label) + '</button>';
      const crumbs = '<div class="dcrumbs fo-crumbs" style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:0 0 6px;font-size:14px">💽 ' + crumb(d.name, '', false) +
        segs.map((x, i) => ' › ' + crumb(x, segs.slice(0, i + 1).join('/'), i === segs.length - 1)).join('') + '</div>';
      const bg = W.sheet(crumbs + '<h3>🗂 ' + esc(it.title) + '</h3><p class="sub" style="margin:-4px 0 8px">' + esc([whatLabel(it.what), 'on ' + d.name, 'added ' + when(it.added_at)].join(' · ')) + '</p>' +
        '<div class="form-grid"><label class="wide">Folder<input class="in" id="fo-p" maxlength="200" value="' + esc(it.path || '') + '" placeholder="e.g. Sharma/Haldi/Candid"' + (canEdit(d) ? '' : ' disabled') + '></label><label>Files<input class="in" id="fo-f" type="number" min="0" inputmode="numeric" value="' + (f != null ? f : '') + '"' + (canEdit(d) ? '' : ' disabled') + '></label><label>Size<input class="in" id="fo-s" maxlength="20" value="' + esc(it.size_label || '') + '" placeholder="e.g. 120 GB"' + (canEdit(d) ? '' : ' disabled') + '></label>' +
        '<label class="wide">Note<input class="in" id="fo-n" maxlength="300" value="' + esc(it.note || '') + '"' + (canEdit(d) ? '' : ' disabled') + '></label></div>' +
        (canEdit(d) ? '<button type="button" class="pillbtn light" id="fo-save" style="width:100%">Save</button>' : '') +
        '<h4>Copies</h4>' + (cp.length ? cp.map(x => { const dd = drives.find(y => y.id === x.drive) || {}; return '<div class="rep">✓ <b>' + esc(dd.name || '?') + '</b> · ' + esc(whatLabel(x.what)) + ' · ' + esc(holderText(dd)) + '</div>'; }).join('') : '<p class="sub">' + (it.what === 'raw' ? 'Only here. Back it up to another drive.' : 'Only here.') + '</p>') +
        (ks.length ? '<h4>Cards in this folder</h4>' + ks.map(k => { const st = ST[k.data] || ['mute', k.data]; return '<span class="pill ' + st[0] + '" style="margin:0 6px 6px 0;display:inline-block">' + esc(k.code) + ' · ' + esc(st[1]) + '</span>'; }).join('') : '') +
        // no backup needed (032): the folder shows it, and its cards with one copy turn copied or free
        (opts.staff && it.what === 'raw' && !cp.length ? (it.no_backup ? '<div class="ans" style="margin:10px 0 0">No backup needed' + (it.no_backup_why ? ': ' + esc(it.no_backup_why) : '') + ' <button type="button" class="x" id="fo-needbk">Needs a backup after all</button></div>'
          : '<h4>No backup needed?</h4><p class="sub">When one copy is enough. Its cards with one copy stop showing amber.</p><div class="form-grid"><label class="wide">Why<input class="in" id="fo-nbw" maxlength="200" placeholder="e.g. client took the raw, reel only"></label></div>' +
            '<div class="pillrow"><button type="button" class="pillbtn light" id="fo-nbc">No backup · cards copied</button><button type="button" class="pillbtn light" id="fo-nbf">No backup · cards free</button></div>') : '') +
        (opts.staff && others.length && !it.no_backup ? '<h4>Back up this folder</h4><p class="sub">Copy the folder in Finder first, then record it here. The cards in it that have only one copy turn <b>Copied ✓</b> (safe to format) by themselves.</p>' +
          '<div class="form-grid"><label class="wide">Backed up to<select class="in" id="fo-to"><option value="">Pick the drive</option>' + others.map(x => '<option value="' + x.id + '">' + esc(x.name + (x.size_label ? ' · ' + x.size_label : '') + ' · ' + holderText(x)) + '</option>').join('') + '</select></label></div>' +
          '<button type="button" class="pillbtn" id="fo-bk" style="width:100%">Record the backup</button>' : '') +
        '<div class="pillrow" style="margin-top:12px">' + (canEdit(d) ? '<button type="button" class="pillbtn light" id="fo-mv">Move / copy</button><button type="button" class="pillbtn light" id="fo-rm">Remove</button>' : '') + '<button type="button" class="pillbtn light" id="fo-x">Close</button></div>');
      bg.querySelectorAll('.fo-crumbs [data-go]').forEach(b => b.addEventListener('click', () => {
        bg.remove(); if (!parent || !document.body.contains(parent)) { openDrive(d, b.dataset.go); return; }
        drawTree(parent, d, items.filter(x => x.drive === d.id), b.dataset.go); const t = parent.querySelector('#dtree'); if (t) t.scrollIntoView({ block: 'start' });
      }));
      const g = s2 => bg.querySelector(s2), on = (s2, fn) => { const x = g(s2); if (x) x.addEventListener('click', fn); };
      const back = async P2 => { bg.remove(); if (parent) parent.remove(); await refresh(); openDrive(drives.find(x => x.id === d.id), P2 != null ? P2 : (it.path || '')); };
      on('#fo-x', () => bg.remove());
      on('#fo-save', async () => {
        const fv = g('#fo-f').value.trim(), row = { path: g('#fo-p').value.trim() || null, size_label: g('#fo-s').value.trim() || null, note: g('#fo-n').value.trim() || null, files: fv === '' ? null : Math.max(0, Math.round(Number(fv)) || 0) };
        const { error } = await c.from('drive_items').update(row).eq('id', it.id);
        if (error) { toast('Could not save: ' + error.message, true); return; }
        toast('Saved.'); await back(row.path ? row.path.split('/').filter(Boolean).join('/') : '');
      });
      on('#fo-bk', async () => {
        const to = g('#fo-to').value; if (!to) { toast('Pick the drive it was backed up to.', true); return; }
        const r = await rpc('drive_backup_item', { p_item: it.id, p_to: to });
        if (!r) return;
        const dn = (drives.find(x => x.id === to) || {}).name;
        toast('Backed up to ' + dn + '.' + (r.cards_copied ? ' ' + r.cards.join(', ') + (r.cards_copied > 1 ? ' are' : ' is') + ' now Copied ✓ (safe to format).' : ''));
        await back();
      });
      const noBk = async free => { const r = await rpc('drive_no_backup', { p_item: it.id, p_why: (g('#fo-nbw') || {}).value || '', p_free: free }); if (!r) return;
        toast('No backup needed for ' + it.title + '.' + (r.cards && r.cards.length ? ' ' + r.cards.join(', ') + (r.cards.length > 1 ? ' are' : ' is') + ' now ' + (free ? 'free' : 'Copied ✓') + '.' : '')); await back(); };
      on('#fo-nbc', () => noBk(false)); on('#fo-nbf', () => noBk(true));
      on('#fo-needbk', async () => { if (!(await rpc('drive_need_backup', { p_item: it.id }))) return; toast(it.title + ' needs a backup again.'); await back(); });
      on('#fo-mv', () => { if (parent) parent.remove(); moveItem(it, d, bg); });
      on('#fo-rm', () => { if (parent) parent.remove(); removeItem(it, d, bg); });
    }

    function give(d, parent) {
      const bg = W.sheet('<h3>Give ' + esc(d.name) + '</h3><p class="sub">They get a notice and must tap <b>I have it</b>. Until then it stays ' + esc(holderText(d).toLowerCase()) + '.</p><div class="form-grid">' +
        '<label class="wide">To<select class="in" id="gto"><option value="">Pick a person</option>' + (d.holder ? '<option value="office">Back to the office (a drive keeper accepts)</option>' : '') + dir.filter(p => p.id !== d.holder).map(p => '<option value="' + p.id + '">' + esc(p.name) + (p.keeper ? ' · drive keeper' : '') + '</option>').join('') + '</select><span class="hint">Someone missing? Only people on Home → People (with their Gmail) can receive drives, the admin and manager too.</span></label>' +
        '<label class="wide">Note (optional)<input class="in" id="gnote" maxlength="300" placeholder="e.g. for Jyoti & Amit reel"></label></div>' +
        '<div class="pillrow"><button type="button" class="pillbtn light" id="gcx">Cancel</button><button type="button" class="pillbtn" id="ggo">Give</button></div>');
      bg.querySelector('#gcx').addEventListener('click', () => bg.remove());
      bg.querySelector('#ggo').addEventListener('click', async () => {
        const v = bg.querySelector('#gto').value; if (!v) { toast('Pick who gets it.', true); return; }
        const r = await rpc('drive_give', { p_drive: d.id, p_to: v === 'office' ? null : v, p_note: bg.querySelector('#gnote').value.trim() || null });
        if (!r) return;
        notify(r.id); bg.remove(); parent.remove(); await refresh();
        toast('Given. Waiting for ' + (v === 'office' ? 'a drive keeper' : nameOf(v)) + ' to accept.');
      });
    }
    function fix(d, parent) {
      const bg = W.sheet('<h3>Where is ' + esc(d.name) + ' really?</h3><p class="sub">Only for corrections (e.g. after the first import). Normal handovers use Give.</p><div class="form-grid"><label class="wide">Now with<select class="in" id="fto"><option value="office">In the office</option>' + dir.map(p => '<option value="' + p.id + '"' + (p.id === d.holder ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') + '</select></label><label class="wide">Why<input class="in" id="fwhy" maxlength="200"></label></div>' +
        '<div class="pillrow"><button type="button" class="pillbtn light" id="fcx">Cancel</button><button type="button" class="pillbtn" id="fgo">Save</button></div>');
      bg.querySelector('#fcx').addEventListener('click', () => bg.remove());
      bg.querySelector('#fgo').addEventListener('click', async () => { const v = bg.querySelector('#fto').value; if (await rpc('drive_set_holder', { p_drive: d.id, p_person: v === 'office' ? null : v, p_why: bg.querySelector('#fwhy').value.trim() || null }, 'Corrected.')) { bg.remove(); parent.remove(); await refresh(); } });
    }
    function moveItem(it, d, parent) {
      const others = drives.filter(x => x.id !== d.id && x.status === 'in_use');
      const bg = W.sheet('<h3>Move or copy</h3><p class="sub"><b>' + esc(it.title) + '</b> · ' + esc(whatLabel(it.what)) + ' · now on ' + esc(d.name) + '</p><div class="form-grid"><label class="wide">To drive<input class="in" id="mto" list="dl-drv" placeholder="Type the drive name"></label></div>' +
        '<datalist id="dl-drv">' + others.map(x => '<option value="' + esc(x.name) + '">').join('') + '</datalist>' +
        '<p class="sub">Move: it leaves ' + esc(d.name) + ' (kept in its history). Copy: a backup on both.</p><div class="pillrow"><button type="button" class="pillbtn light" id="mcopy">Copy</button><button type="button" class="pillbtn" id="mmove">Move</button></div>' +
        '<p style="margin-top:8px"><button type="button" class="x" id="mcx">Cancel</button></p>');
      const go = async copy => {
        const t = bg.querySelector('#mto').value.trim().toLowerCase(), to = others.find(x => x.name.toLowerCase() === t);
        if (!to) { toast('Pick a drive from the list.', true); return; }
        if (await rpc('drive_move_item', { p_item: it.id, p_to_drive: to.id, p_copy: copy }, (copy ? 'Copied to ' : 'Moved to ') + to.name + '.')) { bg.remove(); parent.remove(); await refresh(); openDrive(drives.find(x => x.id === d.id)); }
      };
      bg.querySelector('#mcopy').addEventListener('click', () => go(true)); bg.querySelector('#mmove').addEventListener('click', () => go(false));
      bg.querySelector('#mcx').addEventListener('click', () => bg.remove());
    }
    // "Deleted from drive" for folders (033_drive_delete_folders.sql): first a check of what it does (only copies, cards that go back on
    // hold), then the reason; deleting the ONLY copy needs a tick and is for the admin / a manager only
    const DEL_WHY = ['Client delivered', 'Space needed', 'Duplicate', 'Corrupt / unreadable'];
    async function deleteLines(d, ids, words, parent, P) {
      const chk = await rpc('drive_delete_lines', { p_drive: d.id, p_items: ids, p_why: 'check', p_check: true, p_last_ok: false }); if (!chk) return;
      const last = chk.last || [], cards = chk.cards || [], n = chk.count;
      const cardWord = k => k.after === 'hold' ? '<b>' + esc(k.code) + '</b> goes back <b style="color:var(--no-ink,#b23a26)">ON HOLD</b> (no copy left: do not format)' : '<b>' + esc(k.code) + '</b> becomes single copy (backup needed)';
      const bg = W.sheet('<h3>Deleted from ' + esc(d.name) + '</h3><p class="sub"><b>' + esc(words.join(', ')) + '</b> · ' + n + ' item' + (n === 1 ? '' : 's') + '. Mark it here after deleting it on the drive itself. It stays in the drive\'s history and can be brought back.</p>' +
        (last.length ? '<div class="ans wait" id="dl-last" style="margin:0 0 10px;border-color:var(--no-ink,#b23a26)"><b>⚠ The only copy of ' + last.length + ' item' + (last.length > 1 ? 's' : '') + '</b> (no backup or copy on any other drive):<ul style="margin:4px 0 0 18px;padding:0">' +
          last.map(x => '<li>' + esc(x.title) + (x.path ? ' <span class="meta" style="display:inline">(' + esc(x.path) + ')</span>' : '') + (x.no_backup ? ' · no backup needed' : '') + '</li>').join('') + '</ul></div>'
          : '<div class="ans ok" id="dl-safe" style="margin:0 0 10px">✓ Everything here has another copy on a drive.</div>') +
        (cards.length ? '<div class="ans wait" id="dl-cards" style="margin:0 0 10px">Cards: ' + cards.map(cardWord).join(' · ') + '</div>' : '') +
        '<div class="form-grid"><label class="wide">Why<select class="in" id="dl-why">' + DEL_WHY.map(x => '<option>' + esc(x) + '</option>').join('') + '<option value="">Something else…</option></select></label>' +
        '<label class="wide" id="dl-otherbox" hidden>Write why<input class="in" id="dl-other" maxlength="200" data-nosuggest></label></div>' +
        (last.length ? (opts.staff ? '<label style="display:flex;gap:8px;align-items:center;margin:8px 0"><input type="checkbox" id="dl-ok"> I know this is the only copy and it is gone</label>'
          : '<p class="sub" id="dl-noperm" style="color:var(--no-ink,#b23a26)">Only the admin or a manager can mark the only copy as deleted. Untick those items, or ask them.</p>') : '') +
        '<div class="pillrow"><button type="button" class="pillbtn light" id="dl-cx">Cancel</button><button type="button" class="pillbtn" id="dl-go"' + (last.length && !opts.staff ? ' disabled' : '') + '>Mark deleted</button></div>');
      const g = q => bg.querySelector(q);
      g('#dl-why').addEventListener('change', () => { g('#dl-otherbox').hidden = !!g('#dl-why').value; });
      g('#dl-cx').addEventListener('click', () => bg.remove());
      g('#dl-go').addEventListener('click', async () => {
        const why = g('#dl-why').value || g('#dl-other').value.trim(); if (!why) { toast('Write why it was deleted.', true); return; }
        if (last.length && !(g('#dl-ok') && g('#dl-ok').checked)) { toast('Tick "I know this is the only copy" first.', true); return; }
        const r = await rpc('drive_delete_lines', { p_drive: d.id, p_items: ids, p_why: why, p_check: false, p_last_ok: !!last.length }); if (!r) return;
        bg.remove(); if (parent) parent.remove(); await refresh();
        toast(r.deleted + ' item' + (r.deleted === 1 ? '' : 's') + ' marked deleted from ' + d.name + '.' + ((r.cards || []).length ? ' Cards updated: ' + r.cards.map(k => k.code + ' ' + (k.after === 'hold' ? 'on hold' : 'single')).join(', ') + '.' : ''));
        const D = drives.find(x => x.id === d.id), left = items.filter(it => it.drive === d.id && !it.removed_at);
        openDrive(D, P && left.some(it => under(it, P)) ? P : '');
      });
    }
    function removeItem(it, d, parent) {
      const bg = W.sheet('<h3>Remove from ' + esc(d.name) + '</h3><p class="sub"><b>' + esc(it.title) + '</b> · ' + esc(whatLabel(it.what)) + '. It stays in the drive\'s history.</p><div class="form-grid"><label class="wide">Why<select class="in" id="rwhy"><option value="cleaned">Deleted / cleaned from the drive</option><option value="delivered">Given to the client</option><option value="mistake">Listed by mistake</option></select></label></div>' +
        '<div class="pillrow"><button type="button" class="pillbtn light" id="rcx">Cancel</button><button type="button" class="pillbtn" id="rgo">Remove</button></div>');
      bg.querySelector('#rcx').addEventListener('click', () => bg.remove());
      bg.querySelector('#rgo').addEventListener('click', async () => {
        const { error } = await c.from('drive_items').update({ removed_at: new Date().toISOString(), removed_why: bg.querySelector('#rwhy').value }).eq('id', it.id);
        if (error) { toast('Could not remove: ' + error.message, true); return; }
        bg.remove(); parent.remove(); await refresh(); openDrive(drives.find(x => x.id === d.id));
      });
    }
    function clean(d, its, parent) {
      const bg = W.sheet('<h3>Cleaned ' + esc(d.name) + '</h3><p class="sub">Tick what was deleted. It stays in the history, so you can always see what was on it.</p>' +
        (its.length ? '<div class="checks" id="cl-it">' + its.map(it => '<label><input type="checkbox" value="' + it.id + '">' + esc(it.title) + ' · ' + esc(whatLabel(it.what)) + '</label>').join('') + '</div>' : '') +
        '<div class="form-grid" style="margin-top:10px"><label>Cleaned on<input class="in" type="date" id="cl-d" value="' + W.todayIST() + '"></label><label>Free space now<input class="in" id="cl-f" maxlength="20" placeholder="e.g. 1.6 TB"></label></div>' +
        '<div class="pillrow"><button type="button" class="pillbtn light" id="clcx">Cancel</button><button type="button" class="pillbtn" id="clgo">Save</button></div>');
      bg.querySelector('#clcx').addEventListener('click', () => bg.remove());
      bg.querySelector('#clgo').addEventListener('click', async () => {
        const ids = [...bg.querySelectorAll('#cl-it input:checked')].map(i => i.value);
        if (ids.length) { const { error } = await c.from('drive_items').update({ removed_at: new Date().toISOString(), removed_why: 'cleaned' }).in('id', ids); if (error) { toast('Could not save: ' + error.message, true); return; } }
        const { error } = await c.from('drives').update({ cleaned_on: bg.querySelector('#cl-d').value || W.todayIST(), free_label: bg.querySelector('#cl-f').value.trim() || null }).eq('id', d.id);
        if (error) { toast('Could not save: ' + error.message, true); return; }
        bg.remove(); parent.remove(); await refresh(); toast('Saved.');
      });
    }
    function editDrive(d) {
      const x = d || { kind: 'HDD', owner_type: 'studio', status: 'in_use' };
      const sel = (id, opts2, v) => '<select class="in" id="' + id + '">' + opts2.map(([k, l]) => '<option value="' + k + '"' + (k === v ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
      const bg = W.sheet('<h3>' + (d ? 'Edit ' + esc(d.name) : 'Add a drive') + '</h3><div class="form-grid">' +
        '<label>Name (as the team says it)<input class="in" id="e-n" maxlength="60" value="' + esc(x.name || '') + '" placeholder="e.g. M 10"></label>' +
        '<label>Whose<select class="in" id="e-o"><option value="studio"' + (x.owner_type === 'studio' ? ' selected' : '') + '>Muto\'s drive</option><option value="client"' + (x.owner_type === 'client' ? ' selected' : '') + '>Client\'s drive</option></select></label>' +
        '<label>Client (if theirs)<input class="in" id="e-c" maxlength="120" value="' + esc(x.client_name || '') + '"></label>' +
        '<label>Type' + sel('e-k', [['HDD', 'Hard disk'], ['SSD', 'SSD'], ['NAS', 'NAS'], ['Card', 'Memory card'], ['Other', 'Other']], x.kind) + '</label>' +
        '<label>Size<input class="in" id="e-s" maxlength="20" value="' + esc(x.size_label || '') + '" placeholder="2 TB"></label>' +
        '<label>Model<input class="in" id="e-m" maxlength="60" value="' + esc(x.model || '') + '" placeholder="Crucial X9"></label>' +
        '<label>Format<input class="in" id="e-f" maxlength="40" value="' + esc(x.format || '') + '" placeholder="exFAT"></label>' +
        '<label>Free space<input class="in" id="e-fr" maxlength="20" value="' + esc(x.free_label || '') + '"></label>' +
        (d ? '<label>Status' + sel('e-st', Object.entries(STATUS), x.status) + '</label>' : '') +
        '<label class="wide">Notes<input class="in" id="e-no" maxlength="500" value="' + esc(x.notes || '') + '"></label></div>' +
        '<div class="pillrow"><button type="button" class="pillbtn light" id="e-cx">Cancel</button><button type="button" class="pillbtn" id="e-go">Save</button></div>' +
        (d && opts.owner ? '<p style="margin-top:10px"><button type="button" class="x" id="e-del" style="color:var(--no-ink)">Delete this drive from the register</button></p>' : ''));
      const g = id => bg.querySelector(id);
      g('#e-cx').addEventListener('click', () => bg.remove());
      g('#e-go').addEventListener('click', async () => {
        const row = { name: g('#e-n').value.trim(), owner_type: g('#e-o').value, client_name: g('#e-c').value.trim() || null, kind: g('#e-k').value, size_label: g('#e-s').value.trim() || null, model: g('#e-m').value.trim() || null, format: g('#e-f').value.trim() || null, free_label: g('#e-fr').value.trim() || null, notes: g('#e-no').value.trim() || null };
        if (!row.name) { toast('Give the drive a name.', true); return; }
        if (drives.some(o => o.name.toLowerCase() === row.name.toLowerCase() && (!d || o.id !== d.id))) { toast('There is already a drive called ' + row.name + '.', true); return; }
        if (d) row.status = g('#e-st').value;
        const { error } = d ? await c.from('drives').update(row).eq('id', d.id) : await c.from('drives').insert(row);
        if (error) { toast('Could not save: ' + error.message, true); return; }
        bg.remove(); await refresh(); toast(d ? 'Saved.' : row.name + ' added (in the office).');
      });
      const del = g('#e-del'); if (del) del.addEventListener('click', async () => {
        if (!confirm('Delete ' + d.name + ' and its list from the register? Use status "Retired" instead if it just stopped being used.')) return;
        const { error } = await c.from('drives').delete().eq('id', d.id); if (error) { toast('Could not delete: ' + error.message, true); return; }
        bg.remove(); await refresh(); toast('Deleted.');
      });
    }

    // open a drive straight at a line's folder, with that line's panel open (Client data, an editor's "Where is the data?"):
    // by ids, or by drive name + title when only those are known
    async function openAt(o) {
      if (!drives.length) await load();
      const d = drives.find(x => x.id === o.drive) || drives.find(x => o.driveName && x.name === o.driveName); if (!d) { toast('That drive is not in the register any more.', true); return false; }
      const it = items.find(x => x.id === o.item && x.drive === d.id) || (o.title ? items.find(x => x.drive === d.id && x.title === o.title) : null);
      openDrive(d, it ? pathOf(it) : '');
      if (it) { const all = document.querySelectorAll('.sheet-bg'), b = all.length && all[all.length - 1].querySelector('.dfolder[data-fo="' + it.id + '"]'); if (b) b.click(); }
      else if (o.item) toast('That line is no longer on ' + d.name + ' (see "Removed from this drive").');
      return true;
    }
    return { refresh, waiting, render, openAt };
  }
  window.MutosDrives = { mount, WHAT, whatLabel };
})();
