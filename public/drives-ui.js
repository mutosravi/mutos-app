// Muto's app · Drive register screens, shared by the Work desk (desk.html) and My work (mywork.html).
// MutosDrives.mount(el, opts) draws the list + search; tapping a drive opens its sheet (details, what is on it, give → accept, history).
// opts: { c, me (my person id or null), staff, owner, keeper, toast(msg, bad), weddings: [{ key, title }] }
(function () {
  const W = window.MutosWork, esc = W.esc;
  const WHAT = [['raw', 'Raw'], ['project', 'Project'], ['render', 'Render'], ['final', 'Final output'], ['backup', 'Backup copy'], ['other', 'Other']];
  const whatLabel = k => (WHAT.find(x => x[0] === k) || [k, k])[1];
  const STATUS = { in_use: 'In use', delivered: 'Delivered to client', faulty: 'Faulty', retired: 'Retired' };
  const when = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', hour: 'numeric', minute: '2-digit' }) : '';

  function mount(el, opts) {
    const c = opts.c, toast = opts.toast;
    let drives = [], items = [], moves = [], dir = [], view = 'all', q = '';
    const nameOf = id => id ? ((dir.find(p => p.id === id) || {}).name || 'someone') : 'the office';
    const holderText = d => d.status === 'delivered' ? 'Delivered to client' : d.holder ? 'With ' + nameOf(d.holder) : 'In the office';
    const pendingOf = d => moves.find(m => m.drive === d.id && m.status === 'pending');
    const forMe = m => m.status === 'pending' && ((m.to_person && m.to_person === opts.me) || (!m.to_person && (opts.keeper || opts.staff)));
    const canGive = d => d.status === 'in_use' && (opts.staff || (d.holder && d.holder === opts.me) || (!d.holder && opts.keeper));
    // drive details: only the studio (owner, manager). Data on a drive: the studio or whoever has it.
    // A drive keeper only hands over and receives (Ravi, 11 Nov 2026; 016_keeper_handover_only.sql)
    const canEdit = d => opts.staff || (d.holder && d.holder === opts.me);

    async function load() {
      const [d, i, m, p] = await Promise.all([
        c.from('drives').select('*').order('name'),
        c.from('drive_items').select('*').is('removed_at', null),
        c.from('drive_moves').select('*').eq('status', 'pending'),
        c.rpc('people_directory')
      ]);
      if (d.error) throw d.error;
      drives = d.data || []; items = i.error ? [] : (i.data || []); moves = m.error ? [] : (m.data || []); dir = p.error ? [] : (p.data || []);
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

    async function openDrive(d) {
      if (!d) return;
      const its = items.filter(it => it.drive === d.id), pm = pendingOf(d);
      const bg = W.sheet('<h3>' + esc(d.name) + '</h3><p class="sub" style="margin:-4px 0 8px">' + esc([[d.size_label, d.kind].filter(Boolean).join(' '), d.model, d.format, d.owner_type === 'client' ? 'client drive' + (d.client_name && d.client_name !== d.name ? ': ' + d.client_name : '') : 'studio drive'].filter(Boolean).join(' · ')) + '</p>' +
        '<div class="ans ' + (pm ? 'wait' : d.status !== 'in_use' ? 'no' : 'ok') + '" style="margin:0 0 10px"><b>' + esc(holderText(d)) + '</b>' + (pm ? ' · given to ' + esc(nameOf(pm.to_person)) + ', waiting for them to accept' + (pm.note ? ' (' + esc(pm.note) + ')' : '') : '') + (d.free_label || d.cleaned_on ? '<br>' + esc([d.free_label ? d.free_label + ' free' : '', d.cleaned_on ? 'cleaned ' + W.dayLong(d.cleaned_on) : ''].filter(Boolean).join(' · ')) : '') + (d.notes ? '<br>' + esc(d.notes) : '') + '</div>' +
        '<div class="pillrow" style="margin-bottom:8px">' +
          (pm && forMe(pm) ? '<button type="button" class="pillbtn light" id="dno">Not received</button><button type="button" class="pillbtn" id="dyes">I have it ✓</button>'
            : (canGive(d) ? '<button type="button" class="pillbtn" id="dgive">' + (d.holder ? 'Give to someone' : 'Give out') + '</button>' : '') + (pm && (opts.staff || pm.given_by === opts.email) ? '<button type="button" class="pillbtn light" id="dcancel">Take back the handover</button>' : opts.staff ? '<button type="button" class="pillbtn light" id="dedit">Edit details</button>' : '')) + '</div>' +
        '<h4>On this drive</h4>' + (its.length ? its.map(it => '<div class="rep" style="display:flex;justify-content:space-between;gap:8px;align-items:center"><span><b>' + esc(it.title) + '</b> · ' + esc(whatLabel(it.what)) + (it.size_label ? ' · ' + esc(it.size_label) : '') + (it.note ? '<br><span class="meta">' + esc(it.note) + '</span>' : '') + '</span>' +
          (canEdit(d) ? '<span style="display:flex;gap:6px;flex:0 0 auto"><button type="button" class="chip" data-mv="' + it.id + '">Move / copy</button><button type="button" class="chip" data-rm="' + it.id + '">Remove</button></span>' : '') + '</div>').join('') : '<p class="sub">Nothing listed yet.</p>') +
        (canEdit(d) ? '<div id="addbox"><div class="form-grid" style="margin-top:8px"><label class="wide">Wedding or event<input class="in" id="it-t" list="dl-wed" maxlength="160" placeholder="e.g. Jyoti & Amit · Haldi"></label>' +
          '<label>What<select class="in" id="it-w">' + WHAT.map(([k, l]) => '<option value="' + k + '">' + l + '</option>').join('') + '</select></label><label>Size<input class="in" id="it-s" maxlength="20" placeholder="e.g. 600 GB"></label>' +
          '<label class="wide">Note<input class="in" id="it-n" maxlength="300" placeholder="optional"></label></div><button type="button" class="pillbtn light" id="it-add" style="width:100%">＋ Add to this drive</button></div>' : '') +
        (opts.staff && d.status === 'in_use' ? '<button type="button" class="pillbtn light" id="dclean" style="width:100%;margin-top:8px">Cleaned this drive</button>' : '') +
        (opts.owner ? '<p style="margin-top:10px"><button type="button" class="x" id="dfix">Correct where it is</button></p>' : '') +
        '<h4>History</h4><div id="dhist" class="sub">Loading…</div>' +
        '<div class="pillrow" style="margin-top:12px"><button type="button" class="pillbtn light" id="dclose">Close</button></div>' +
        '<datalist id="dl-wed">' + (opts.weddings || []).map(w => '<option value="' + esc(w.title) + '">').join('') + '</datalist>');
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
        const { error } = await c.from('drive_items').insert({ drive: d.id, title: t, what: g('#it-w').value, size_label: g('#it-s').value.trim() || null, note: g('#it-n').value.trim() || null, wedding_key: w ? w.key : null });
        if (error) { toast('Could not add: ' + error.message, true); return; }
        bg.remove(); await refresh(); toast('Added to ' + d.name + '.'); openDrive(drives.find(x => x.id === d.id));
      });
      bg.querySelectorAll('[data-mv]').forEach(b => b.addEventListener('click', () => moveItem(items.find(it => it.id === b.dataset.mv), d, bg)));
      bg.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => removeItem(items.find(it => it.id === b.dataset.rm), d, bg)));
      const { data: log } = await c.from('drive_log').select('*').eq('drive', d.id).order('at', { ascending: false }).limit(40);
      const h = g('#dhist'); if (h) h.innerHTML = (log || []).length ? log.map(l => '<div class="rep"><span class="meta" style="display:inline">' + esc(when(l.at)) + '</span> · ' + esc(l.what) + '</div>').join('') : 'Nothing yet.';
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

    return { refresh, waiting, render };
  }
  window.MutosDrives = { mount, WHAT, whatLabel };
})();
