// Team app, owner and manager: the header, the Home screen (Today, Needs you, Quick menu, Coming up)
// and the bottom bar on phones. The shoot board stays loaded underneath; "Board" just shows it.
(function () {
  const app = window.mutosApp, ICON = n => window.MUTOS_ICON(n);
  const esc = s => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const pad = n => String(n).padStart(2, '0');
  const dstr = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + n); return dstr(d); };
  let who = null, cardSum = null, myDay = null;
  const sup = () => who && who.role === 'supervisor'; // supervisor: Shoots (add, itinerary), Work desk, Clients without money
  const api = () => window.__boardApi || null;
  const click = id => { const el = document.getElementById(id); if (el) el.click(); };

  // ---------- which screen is showing: Home or Board ----------
  function view() { return location.hash === '#board' ? 'board' : 'home'; }
  function show(v, opts) {
    if (v !== view()) { if (opts && opts.replace) history.replaceState(null, '', v === 'board' ? '#board' : location.pathname + location.search); else if (v === 'board') location.hash = 'board'; else history.pushState(null, '', location.pathname + location.search); }
    apply();
  }
  function apply() {
    const v = view();
    document.body.classList.toggle('mh-view-home', v === 'home');
    document.body.classList.toggle('mh-view-board', v === 'board');
    document.querySelectorAll('[data-mh-view]').forEach(b => { const on = b.dataset.mhView === v; b.classList.toggle('on', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
    if (v === 'home') render();
  }
  window.addEventListener('hashchange', apply);
  window.addEventListener('popstate', apply);
  function toBoard(then) { show('board'); if (then) setTimeout(then, 60); }

  // ---------- header + bottom bar ----------
  function buildChrome() {
    const owner = who.role === 'owner';
    const bar = document.createElement('header');
    bar.id = 'mutos-bar'; bar.className = 'mh-bar';
    bar.innerHTML =
      '<a class="logo" href="#" data-mh-home aria-label="Muto\'s, Home"><b aria-hidden="true">Muto\'s</b></a>' +
      '<nav class="mh-tabs" aria-label="Main">' +
        '<button type="button" class="mh-t mh-desk" data-mh-view="home">' + ICON('home') + 'Home</button>' +
        '<button type="button" class="mh-t mh-desk" data-mh-view="board">' + ICON('board') + 'Board</button>' +
        '<button type="button" class="mh-t mh-bell" id="mutos-updates" aria-label="Team updates">' + ICON('bell') + '<span class="mh-desk-l">Team updates</span><b id="mutos-upd-n" class="mh-n" hidden></b></button>' +
        '<a class="mh-t mh-desk" href="/desk.html">' + ICON('film') + 'Work desk</a>' +
        '<a class="mh-t mh-desk" href="/gear.html">' + ICON('box') + 'Gear desk</a>' +
        '<button type="button" class="mh-t mh-desk" id="mutos-settings">' + ICON('settings') + 'Settings</button>' +
        '<button type="button" class="mh-t mh-desk mh-out" id="mutos-out" aria-label="Sign out" title="Sign out">' + ICON('logout') + '</button>' +
      '</nav>' +
      '<div class="mh-who mh-desk-l"><span id="mutos-who"></span> <span id="mutos-feed"></span></div>' +
      '<span id="mutos-saving" hidden></span>';
    bar.querySelector('#mutos-who').textContent = who.email + ' · ' + who.role;
    bar.querySelector('#mutos-out').addEventListener('click', () => app.signOut());
    bar.querySelector('#mutos-updates').addEventListener('click', openUpdates);
    bar.querySelector('#mutos-settings').addEventListener('click', openMore);
    bar.querySelector('[data-mh-home]').addEventListener('click', e => { e.preventDefault(); show('home'); });
    if (sup()) { bar.querySelector('#mutos-updates').remove(); bar.querySelector('a[href="/gear.html"]').remove(); } // day-off approvals and gear are not his
    document.body.insertBefore(bar, document.body.firstChild);

    const home = document.createElement('main');
    home.id = 'mutos-home'; home.className = 'mh-home';
    home.innerHTML = '<div class="mh-wrap"><section class="hello"><span class="avatar" id="mh-av"></span><div><h1 id="mh-hello"></h1><p class="sub" id="mh-date"></p></div></section><div id="mh-body"><div class="hero"><div class="hero-top"><span class="t">Today</span></div><p>Loading the board…</p></div></div></div>';
    bar.after(home);

    const nav = document.createElement('nav');
    nav.className = 'bnav mh-bnav'; nav.setAttribute('aria-label', 'Main');
    nav.innerHTML = '<button type="button" class="tab" data-mh-view="home">' + ICON('home') + 'Home</button>' +
      '<button type="button" class="tab" data-mh-view="board">' + ICON('board') + 'Board</button>' +
      (sup() ? '<a class="tab" href="/desk.html">' + ICON('film') + 'Work</a>' : '<button type="button" class="tab" id="mh-nav-upd">' + ICON('bell') + 'Updates<b class="dot" id="mh-nav-n" hidden></b></button>') +
      '<button type="button" class="tab" id="mh-nav-more">' + ICON('settings') + (sup() ? 'Me' : 'Settings') + '</button>';
    document.body.appendChild(nav);
    document.querySelectorAll('[data-mh-view]').forEach(b => b.addEventListener('click', () => show(b.dataset.mhView)));
    nav.querySelector('#mh-nav-more').addEventListener('click', openMore);
    if (!sup()) {
      nav.querySelector('#mh-nav-upd').addEventListener('click', openUpdates);
      // keep the phone badge in step with the header badge
      const n = bar.querySelector('#mutos-upd-n'), m = nav.querySelector('#mh-nav-n');
      new MutationObserver(() => { m.textContent = n.textContent; m.hidden = n.hidden; }).observe(n, { attributes: true, childList: true, characterData: true, subtree: true });
    }
  }
  function openUpdates() { if (window.MUTOS_UPDATES && api()) window.MUTOS_UPDATES.open(); else toast('Team updates open once the board has loaded.'); }
  function toast(m) { const a = api(); if (a) a.toast(m); }

  // "More" on phones; "Settings" tile everywhere
  function openMore() {
    closeMore();
    const owner = who.role === 'owner';
    const rows = sup() ? [['#out', 'logout', 'Sign out', who.email]] : [
      owner && ['#logins', 'key', 'Team logins', 'Managers, gear desk, who can sign in'],
      owner && ['#backups', 'cloud', 'Backups', 'Nightly copies, download or back up now'],
      ['#save', 'download', 'Save backup file', 'Download everything to this device'],
      ['#load', 'upload', 'Load backup file', 'Bring back a saved backup'],
      ['#excel', 'table', 'Export to Excel', 'All shoots in a spreadsheet'],
      ['#out', 'logout', 'Sign out', who.email]
    ].filter(Boolean);
    const ov = document.createElement('div'); ov.className = 'sb-modal-overlay mh-sheet-bg'; ov.id = 'mh-more';
    ov.innerHTML = '<div class="sb-modal mh-sheet" role="dialog" aria-modal="true" aria-label="Settings"><div class="mh-sheet-head"><b>Settings</b><button type="button" class="mh-x" aria-label="Close">✕</button></div>' +
      rows.map(([href, ic, label, sub]) => (href.startsWith('/') ? '<a class="mh-row" href="' + href + '">' : '<button type="button" class="mh-row" data-act="' + href.slice(1) + '">') + '<span class="mh-ic">' + ICON(ic) + '</span><span><b>' + esc(label) + '</b><small>' + esc(sub) + '</small></span>' + (href.startsWith('/') ? '</a>' : '</button>')).join('') + '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) closeMore(); });
    ov.querySelector('.mh-x').addEventListener('click', closeMore);
    ov.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.act; closeMore();
      if (a === 'logins') { if (window.MUTOS_APP) window.MUTOS_APP.openLogins(); } else if (a === 'backups') { if (window.MUTOS_APP) window.MUTOS_APP.openBackups(); }
      else if (a === 'save') click('sb-backup'); else if (a === 'load') click('sb-restore'); else if (a === 'excel') click('sb-export');
      else if (a === 'out') app.signOut();
    }));
  }
  function closeMore() { const o = document.getElementById('mh-more'); if (o) o.remove(); }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeMore(); closeDesk(); } });

  // ---------- Home ----------
  // Home shows a few desks; each desk opens its own tools (decided 6 Nov: "main categories, then sub categories")
  const DESKS = [
    { k: 'shoots', ic: 'board', title: 'Shoots desk', cls: 'main', tools: [
      ['board', 'board', 'Shoot board', 'main'], ['sb-new-wedding', 'plus', 'New wedding'], ['sb-manage-shooters', 'crew', 'Crew'], ['sb-manage-assistants', 'person', 'Assistants'],
      ['sb-rentals', 'truck', 'Rentals'], ['sb-callsheet', 'sheet', 'Call sheet'], ['sb-prewed', 'ring', 'Pre-wedding'], ['sb-planner', 'drone', 'Drones & freelancers'],
      ['sb-workload', 'bars', 'Workload'], ['sb-billing', 'rupee', 'Billing'], ['sync', 'sync', 'Sync Team Alignment'], ['/crew.html?preview=1', 'eye', 'Crew view'], ['sb-history', 'list', 'History']] },
    { k: 'work', ic: 'film', title: 'Work desk', tools: [
      ['/desk.html', 'film', 'Jobs', 'main'], ['/desk.html?tab=today', 'log', 'Daily reports'], ['/desk.html?tab=month', 'bars', 'Month'], ['/desk.html?tab=drives', 'drive', 'Drives'], ['/cards.html', 'card', 'Cards']] },
    { k: 'gear', ic: 'box', title: 'Gear desk', tools: [
      ['/gear.html', 'box', 'Gear desk', 'main'], ['sb-manage-gear', 'camera', 'Gear list'], ['sb-rentals', 'truck', 'Rentals']] },
    { k: 'clients', ic: 'heart', title: 'Clients', tools: [
      ['clients', 'heart', 'Clients', 'main'], ['packages', 'money', 'Packages']] },
    { k: 'people', ic: 'idcard', title: 'People', tools: [
      ['/desk.html?tab=people', 'idcard', 'People', 'main'], ['/attendance.html', 'clock', 'Attendance', '', 'owner'], ['/attendance.html?tab=hist', 'list', 'Salary history', '', 'owner']] },
    { k: 'settings', ic: 'settings', title: 'Settings' }
  ];
  // what a supervisor gets from each desk (the rest he cannot change, see supervisor.js and 012_supervisor.sql)
  const SUP = { shoots: ['board', 'sb-new-wedding', 'sb-callsheet', 'sb-history'], work: ['/desk.html', '/desk.html?tab=today', '/desk.html?tab=month', '/desk.html?tab=drives', '/cards.html'], clients: ['clients'] };
  const desks = () => sup() ? DESKS.filter(d => SUP[d.k]) : DESKS;
  function deskTools(d) {
    const a = api();
    return (d.tools || []).filter(([k, , , , only]) => (k !== 'sync' || (a && a.canSyncTeam())) && (only !== 'owner' || who.role === 'owner') && (!sup() || (SUP[d.k] || []).includes(k)));
  }
  // one line under each desk card: what needs attention there
  function deskLine(d, ctx) {
    if (d.k === 'shoots') return ctx.today + ' today' + (ctx.short ? ' · ' + ctx.short + ' short on crew' : '') + (ctx.inbox ? ' · ' + ctx.inbox + ' to confirm' : '');
    if (d.k === 'work') return cardSum && cardSum.hold && !sup() ? cardSum.hold + ' card' + (cardSum.hold > 1 ? 's' : '') + ' not copied' : 'Jobs, reports, drives, cards';
    if (d.k === 'gear') return ctx.rent ? ctx.rent + ' rentals to book' : 'Hand out, gear list, rentals';
    if (d.k === 'clients' && sup()) return ctx.cs && ctx.cs.toCheck ? ctx.cs.toCheck + ' to check' : 'Family Gmails and itineraries';
    if (d.k === 'shoots' && sup()) return ctx.today + ' today · add shoots, itinerary, client contact';
    if (d.k === 'clients') return ctx.cs ? [ctx.cs.toCheck ? ctx.cs.toCheck + ' to check' : '', ctx.cs.overdue ? ctx.cs.overdue + ' payment' + (ctx.cs.overdue > 1 ? 's' : '') + ' overdue' : ''].filter(Boolean).join(' · ') || 'Itineraries, packages, payments' : 'Itineraries, packages, payments';
    if (d.k === 'people') return who.role === 'owner' ? 'People, attendance, salaries' : 'Everyone at Muto\'s';
    return 'Logins, backups, export';
  }
  function deskCount(d, ctx) { return d.k === 'work' ? (cardSum && !sup() ? cardSum.hold + cardSum.toOffice : 0) : d.k === 'shoots' ? ctx.short + ctx.inbox : d.k === 'gear' ? ctx.rent : d.k === 'clients' && ctx.cs ? ctx.cs.toCheck + ctx.cs.overdue : 0; }
  function openDesk(k) {
    closeDesk();
    const d = desks().find(x => x.k === k); if (!d) return;
    if (k === 'settings') { openMore(); return; }
    const a = api(), rent = a ? a.rentalsToBook().length : 0, inbox = a ? a.inboxCount() : 0, cs = window.MUTOS_CLIENTS && window.MUTOS_CLIENTS.summary ? window.MUTOS_CLIENTS.summary() : null;
    const ov = document.createElement('div'); ov.className = 'sb-modal-overlay mh-sheet-bg'; ov.id = 'mh-desk';
    ov.innerHTML = '<div class="sb-modal mh-sheet mh-desksheet" role="dialog" aria-modal="true" aria-label="' + esc(d.title) + '"><div class="mh-sheet-head"><b>' + esc(d.title) + '</b><button type="button" class="mh-x" aria-label="Close">✕</button></div>' +
      '<div class="tiles three" id="mh-tiles">' + deskTools(d).map(([k, ic, label, cls]) => {
        const n = k === '/cards.html' ? (cardSum && !sup() ? cardSum.hold + cardSum.toOffice : 0) : k === 'sb-rentals' ? rent : k === 'sync' ? inbox : k === 'clients' && cs ? cs.toCheck + cs.overdue : 0;
        return (k.startsWith('/') ? '<a class="tile' + (cls ? ' ' + cls : '') + '" href="' + k + '">' : '<button type="button" class="tile' + (cls ? ' ' + cls : '') + '" data-tile="' + k + '">') + ICON(ic) + esc(label) + (n ? '<span class="count">' + n + '</span>' : '') + (k.startsWith('/') ? '</a>' : '</button>');
      }).join('') + '</div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) closeDesk(); });
    ov.querySelector('.mh-x').addEventListener('click', closeDesk);
    ov.querySelectorAll('[data-tile]').forEach(b => b.addEventListener('click', () => { closeDesk(); runTile(b.dataset.tile); }));
  }
  function closeDesk() { const o = document.getElementById('mh-desk'); if (o) o.remove(); }
  function runTile(k) {
    const a = api();
    if (k === 'board') toBoard(() => window.scrollTo(0, 0));
    else if (k === 'sync') { if (a) { a.syncTeamSheet(); toast('Syncing Team Alignment…'); } }
    else if (k === 'clients') window.MUTOS_CLIENTS && window.MUTOS_CLIENTS.open();
    else if (k === 'packages') window.MUTOS_CLIENTS && window.MUTOS_CLIENTS.packages && window.MUTOS_CLIENTS.packages();
    else click(k); // the board's own buttons open their windows on top of Home
  }
  let renderT = null;
  function render() {
    clearTimeout(renderT);
    renderT = setTimeout(draw, 30);
  }
  function draw() {
    if (!who || view() !== 'home') return;
    const first = String(who.name || who.email).split(/[\s@]/)[0];
    document.getElementById('mh-av').textContent = first.charAt(0).toUpperCase();
    document.getElementById('mh-hello').textContent = 'Hello, ' + first.charAt(0).toUpperCase() + first.slice(1);
    const a = api(), t = dstr(new Date());
    document.getElementById('mh-date').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' }) + (a ? ' · ' + a.seasonOf(t).label.split(' · ')[0] : '');
    if (!a) return; // the board is still loading
    const st = a.state(), act = st.events.filter(a.isActive);
    const todayEv = act.filter(e => e.date === t), short = todayEv.filter(a.isShort), gear = todayEv.filter(e => !a.isShort(e) && a.isGearShort(e)), clash = todayEv.filter(a.hasConflict);
    const ready = todayEv.filter(e => !a.isShort(e) && !a.isGearShort(e) && !a.hasConflict(e));
    const next = act.filter(e => e.date > t).sort((x, y) => x.date.localeCompare(y.date))[0];
    // his own attendance (11 Nov 2026: the supervisor, or a manager, who is also an employee): check in / out on the team home
    const md = myDay ? '<a class="card myday" id="mh-myday" href="/me.html" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;margin:0 0 14px;background:var(--surface);border-radius:20px;padding:14px 16px;box-shadow:var(--shadow);color:var(--rose)">' + window.MUTOS_ICON('clock', 26) + '<span style="flex:1;color:var(--ink)"><b style="display:block">My attendance</b><small class="sub">' + esc(myDay.text) + '</small></span><span class="pillbtn" style="min-height:38px;padding:0 14px;display:inline-flex;align-items:center">' + esc(myDay.action) + '</span></a>' : '';
    let h = '<div class="mh-col">' + md + '<section class="hero"><div class="hero-top"><span class="t">Today</span><span class="badge-w">' + todayEv.length + ' shoot' + (todayEv.length === 1 ? '' : 's') + '</span></div>';
    if (todayEv.length) {
      h += '<div class="statgrid"><button type="button" class="stat" data-filter-go="all"><b>' + ready.length + '</b><span>ready</span></button>' +
        '<button type="button" class="stat honey" data-filter-go="short"><b>' + short.length + '</b><span>short on crew</span></button>' +
        (clash.length ? '<button type="button" class="stat peach" data-filter-go="clash"><b>' + clash.length + '</b><span>double-booked</span></button>' : '<button type="button" class="stat peach" data-filter-go="gear"><b>' + gear.length + '</b><span>short on gear</span></button>') + '</div>' +
        '<button type="button" class="pillbtn" data-go-date="' + t + '">Open today on the board</button>';
    } else h += '<p>No shoots today.' + (next ? ' Next: <b>' + esc(next.name) + '</b>, ' + esc(a.formatDay(next.date)) + '.' : '') + '</p><button type="button" class="pillbtn" data-go-date="' + (next ? next.date : '') + '">' + (next ? 'Open ' + esc(a.formatDay(next.date)) + ' on the board' : 'Open the board') + '</button>';
    h += '</section>';
    // needs you
    const u = window.MUTOS_UPDATES && window.MUTOS_UPDATES.summary ? window.MUTOS_UPDATES.summary() : null;
    const week = act.filter(e => e.date >= t && e.date <= addDays(t, 6));
    const needs = [];
    if (u && (u.pending.length || u.cant.length)) needs.push(['updates', 'honey', u.pending.length + u.cant.length, u.pending.length ? 'Day-off requests' : 'Can\'t make it', u.pending.length && u.cant.length ? 'and "can\'t make it"' : u.pending.length ? 'waiting for you' : 'crew who can\'t come']);
    const inbox = a.inboxCount(); if (inbox) needs.push(['inbox', 'lilac', inbox, 'Team Alignment', 'bookings to confirm']);
    const rent = a.rentalsToBook().length; if (rent) needs.push(['rentals', 'peach', rent, 'Rentals to book', 'with the vendors']);
    const wShort = week.filter(a.isShort).length; if (wShort) needs.push(['short', 'blush', wShort, 'Short on crew', 'in the next 7 days']);
    const wClash = week.filter(a.hasConflict).length; if (wClash) needs.push(['clash', 'peach', wClash, 'Double-booked', 'in the next 7 days']);
    const csum = window.MUTOS_CLIENTS && window.MUTOS_CLIENTS.summary ? window.MUTOS_CLIENTS.summary() : null;
    if (sup()) needs.length = 0; // crew, gear and day-off decisions are not his; family itineraries are (below)
    if (csum && csum.toCheck) needs.splice(Math.min(1, needs.length), 0, ['clients', 'lilac', csum.toCheck, 'Client itineraries', 'sent by families, to check']);
    if (csum && csum.overdue && !sup()) needs.splice(0, 0, ['clients', 'peach', csum.overdue, 'Payments overdue', 'from families']);
    if (csum && csum.dueSoon && !sup()) needs.push(['clients', 'sand', csum.dueSoon, 'Payments due', 'in the next 7 days']);
    if (u && u.unconf.length && !sup()) needs.push(['updates', 'sand', u.unconf.length, 'Not confirmed', 'by crew, next 7 days']);
    if (u && u.data.length && !sup()) needs.push(['updates', 'sand', u.data.length, 'Data handover', 'still with the crew']);
    // memory cards (014_cards.sql): returned to the office and waiting, footage not copied for over a day, lost
    if (cardSum && !sup()) {
      if (cardSum.lost) needs.splice(0, 0, ['cards', 'peach', cardSum.lost, 'Card lost', 'check it now']);
      if (cardSum.holdOld) needs.splice(Math.min(1, needs.length), 0, ['cards', 'peach', cardSum.holdOld, 'Cards not copied', 'on hold for over a day']);
      if (cardSum.toOffice) needs.push(['cards', 'honey', cardSum.toOffice, 'Cards returned', 'waiting for you to accept']);
    }
    h += '<div class="sechead"><h2>Needs you</h2>' + (needs.length > 4 ? '<button type="button" class="allbtn" id="mh-needs-all">All ' + needs.length + ICON('chev').replace('<svg', '<svg width="14" height="14"') + '</button>' : '') + '</div>';
    h += needs.length ? '<div class="needs" id="mh-needs">' + needs.map(([k, cls, n, title, sub], i) => '<button type="button" class="need ' + cls + '" data-need="' + k + '"' + (i > 3 ? ' hidden' : '') + '><span class="n">' + n + (k === 'inbox' || (k === 'updates' && i === 0) ? ' new' : '') + '</span><strong>' + esc(title) + '</strong><span>' + esc(sub) + '</span></button>').join('') + '</div>'
      : '<div class="allclear">Nothing needs you right now. 🎉</div>';
    // quick menu
    const cs = window.MUTOS_CLIENTS && window.MUTOS_CLIENTS.summary ? window.MUTOS_CLIENTS.summary() : null;
    const ctx = { today: todayEv.length, short: sup() ? 0 : wShort, inbox: sup() ? 0 : inbox, rent, cs: cs && sup() ? Object.assign({}, cs, { overdue: 0, dueSoon: 0 }) : cs };
    h += '</div><div class="mh-col"><div class="sechead"><h2>Desks</h2></div><div class="desks" id="mh-desks">' + desks().map(d => {
      const n = deskCount(d, ctx);
      return '<button type="button" class="desk' + (d.cls ? ' ' + d.cls : '') + '" data-desk="' + d.k + '">' + ICON(d.ic) + '<b>' + esc(d.title) + '</b><small>' + esc(deskLine(d, ctx)) + '</small>' + (n ? '<span class="count">' + n + '</span>' : '') + '</button>';
    }).join('') + '</div>';
    // coming up
    const up = act.filter(e => e.date >= t).sort((x, y) => x.date.localeCompare(y.date) || String(x.slot).localeCompare(String(y.slot))).slice(0, 6);
    h += '<div class="sechead"><h2>Coming up</h2><button type="button" class="allbtn" data-tile="board">All' + ICON('chev').replace('<svg', '<svg width="14" height="14"') + '</button></div>';
    h += up.length ? up.map(e => {
      const d = new Date(e.date + 'T12:00:00'), need = a.crewNeeded(e.coverage), have = a.crewCount(e);
      const pill = a.hasConflict(e) ? '<span class="pill no">Double-booked</span>' : a.isShort(e) ? '<span class="pill wait">' + have + ' of ' + need + ' crew</span>' : a.isGearShort(e) ? '<span class="pill wait">Gear short</span>' : '<span class="pill ok">Ready</span>';
      return '<button type="button" class="evrow" data-go-date="' + e.date + '"><span class="dblock"><b>' + d.getDate() + '</b><span>' + d.toLocaleDateString('en-IN', { month: 'short' }) + '</span></span><span class="txt"><b>' + esc(e.name) + '</b><span>' + esc([e.date === t ? 'Today' : e.date === addDays(t, 1) ? 'Tomorrow' : d.toLocaleDateString('en-IN', { weekday: 'short' }), e.slot, e.location].filter(Boolean).join(' · ')) + '</span></span>' + pill + '</button>';
    }).join('') : '<div class="allclear">No upcoming shoots on the board.</div>';
    h += '</div>';
    const body = document.getElementById('mh-body');
    const y = window.scrollY;
    body.innerHTML = h;
    window.scrollTo(0, y);
    // actions
    body.querySelectorAll('[data-filter-go]').forEach(b => b.addEventListener('click', () => toBoard(() => { const f = document.querySelector('#sb-filter-chips [data-filter="' + b.dataset.filterGo + '"]'); if (f) f.click(); a.goToDate(t); })));
    body.querySelectorAll('[data-go-date]').forEach(b => b.addEventListener('click', () => toBoard(() => { if (b.dataset.goDate) a.goToDate(b.dataset.goDate); })));
    body.querySelectorAll('[data-need]').forEach(b => b.addEventListener('click', () => {
      const k = b.dataset.need;
      if (k === 'updates') openUpdates(); else if (k === 'inbox') a.openInbox(); else if (k === 'rentals') a.openRentals(); else if (k === 'clients') window.MUTOS_CLIENTS.open(); else if (k === 'cards') location.assign(cardSum && cardSum.holdOld && !cardSum.toOffice ? '/cards.html?tab=copy' : '/cards.html');
      else toBoard(() => { const f = document.querySelector('#sb-filter-chips [data-filter="' + (k === 'short' ? 'short' : 'clash') + '"]'); if (f) f.click(); window.scrollTo(0, 0); });
    }));
    const na = document.getElementById('mh-needs-all'); if (na) na.addEventListener('click', () => { body.querySelectorAll('#mh-needs [hidden]').forEach(x => { x.hidden = false; }); na.remove(); });
    body.querySelectorAll('[data-desk]').forEach(b => b.addEventListener('click', () => openDesk(b.dataset.desk)));
    body.querySelectorAll('[data-tile]').forEach(b => b.addEventListener('click', () => runTile(b.dataset.tile)));
  }

  // my attendance today (anyone with an active employees row except the owner)
  async function loadMyDay() {
    if (!who || who.role === 'owner') return;
    try {
      const c = await app.client(), today = dstr(new Date());
      const e = await c.from('employees').select('email, active').eq('email', who.email).maybeSingle();
      if (e.error || !e.data || !e.data.active) { if (myDay) { myDay = null; render(); } return; }
      const p = await c.from('att_punch').select('kind, at').eq('email', who.email).eq('day', today);
      const list = (p.data || []).sort((x, y) => String(x.at).localeCompare(String(y.at))), last = list[list.length - 1];
      const tm = x => new Date(x.at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
      const inP = list.find(x => x.kind === 'in');
      const next = !last ? { text: 'Not checked in yet today', action: 'Check in' } : last.kind === 'out' ? { text: 'Checked in ' + tm(inP || last) + ' · out ' + tm(last), action: 'Open' }
        : last.kind === 'lunch_out' ? { text: 'On lunch break since ' + tm(last), action: 'Back' } : { text: 'Checked in at ' + tm(inP || last), action: 'Check out' };
      if (myDay && myDay.text === next.text) return;
      myDay = next; render();
    } catch (e) {}
  }
  // memory cards for Needs you and the Work desk (quietly nothing before 014_cards.sql is run)
  async function loadCards() {
    try {
      const c = await app.client();
      const [k, m] = await Promise.all([c.from('cards').select('id, data, data_since, condition'), c.from('card_moves').select('id, to_person').eq('status', 'pending')]);
      if (k.error) return;
      const ks = k.data || [], day = Date.now() - 864e5;
      const next = { hold: ks.filter(x => x.data === 'hold').length, holdOld: ks.filter(x => x.data === 'hold' && x.data_since && new Date(x.data_since).getTime() < day).length,
        lost: ks.filter(x => x.condition === 'lost').length, toOffice: (m.data || []).filter(x => !x.to_person).length };
      if (JSON.stringify(next) === JSON.stringify(cardSum)) return;
      const was = cardSum; cardSum = next;
      if (was || next.hold || next.toOffice || next.lost) render();   // nothing to show: no redraw
    } catch (e) {}
  }

  // ---------- start ----------
  document.addEventListener('DOMContentLoaded', async () => {
    try { who = await app.me(); } catch (e) { return; }
    if (!who || !['owner', 'manager', 'supervisor'].includes(who.role)) return; // shim.js sends everyone else away
    buildChrome();
    apply();
    // redraw Home when the board changes (its summary line is redrawn on every change) and when Team updates change
    const watch = () => { const s = document.getElementById('sb-summary'); if (s) new MutationObserver(render).observe(s, { childList: true, subtree: true }); };
    watch();
    document.addEventListener('mutos:updates', render);
    loadCards(); setInterval(loadCards, 5 * 60 * 1000); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { loadCards(); loadMyDay(); } });
    loadMyDay(); setInterval(loadMyDay, 2 * 60 * 1000);
    const wait = setInterval(() => { if (api()) { clearInterval(wait); render(); } }, 300);
    // the board's own windows close back to whatever was showing; refresh Home when one closes
    new MutationObserver(() => { if (!document.getElementById('sb-active-modal')) render(); }).observe(document.body, { childList: true });
  });
})();
