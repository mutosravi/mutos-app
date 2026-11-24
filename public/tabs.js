// Tabs on a computer (23 Nov 2026, Ravi: "Multiple tabs opening option in desktop version which allows working on various desks at
// once and I do not need to go to home or close cards or any other desk to reach to shoot desk to see something.")
// The studio page (board.html: Home + Board) is the first tab and never closes. Any other app page opened from it (Cards, Work
// desk, Drives, Gear desk, Attendance, Team home, a crew preview…) opens in its own tab under the top bar instead of replacing
// the page; each tab keeps its place (scroll, open drive, typed search) while you switch. A link inside a tab that goes to
// another app page opens (or switches to) that page's tab. Ctrl / ⌘ / middle-click still opens a real browser tab.
// Only on computers (wide screen with a mouse); phones keep one page at a time with Back. Open tabs come back after a reload.
(function () {
  const wide = () => window.matchMedia('(min-width: 900px) and (hover: hover) and (pointer: fine)').matches;
  if (window.top !== window) return;                      // only the main page hosts tabs
  const KEY = 'mutos-tabs', NAMES = { cards: 'Cards', desk: 'Work desk', gear: 'Gear desk', attendance: 'Attendance', mywork: 'My work', me: 'Team home', crew: 'Shoots (crew)', work: 'My attendance' };
  const HOST = new Set(['/board.html', '/', '/index.html']);
  let tabs = [], active = 'home', seq = 0, strip = null, frames = null;

  const pageOf = u => { try { const x = new URL(u, location.href); return x.origin === location.origin && /\.html$/.test(x.pathname) ? x : null; } catch (e) { return null; } };
  const isAppPage = x => x && !HOST.has(x.pathname) && !/\/(client|office|index|bill)\.html$/.test(x.pathname);
  const baseName = x => NAMES[x.pathname.replace(/^\/|\.html$/g, '')] || x.pathname.replace(/^\/|\.html$/g, '');
  const label = x => { const t = new URLSearchParams(x.search).get('tab'), extra = { drives: 'Drives', today: 'Reports', month: 'Month', people: 'People', copy: 'To copy', hist: 'History', away: 'Days off' }[t];
    return x.pathname === '/desk.html' && extra ? extra : baseName(x) + (x.pathname !== '/desk.html' && extra ? ' · ' + extra : ''); };
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify({ tabs: tabs.map(t => ({ url: t.url, title: t.title })), active: active === 'home' ? 'home' : tabs.findIndex(t => t.id === active) })); } catch (e) {} };

  function ensureUi() {
    if (strip) return;
    const st = document.createElement('style');
    st.textContent = '#mutos-tabs{position:sticky;top:var(--mh-bar-h,56px);z-index:1160;display:flex;gap:4px;align-items:flex-end;padding:6px 12px 0;background:var(--bg,#fbf6f2);border-bottom:1px solid rgba(42,30,34,.12);overflow-x:auto;scrollbar-width:none}' +
      '#mutos-tabs[hidden]{display:none}#mutos-tabs::-webkit-scrollbar{display:none}' +
      '.mt-tab{display:inline-flex;align-items:center;gap:6px;max-width:220px;min-height:34px;padding:0 6px 0 14px;border:1px solid transparent;border-bottom:0;border-radius:10px 10px 0 0;background:transparent;color:#6f5f63;font:600 13px/1 "Open Sans",system-ui,sans-serif;cursor:pointer;white-space:nowrap;flex:0 0 auto}' +
      '.mt-tab:hover{background:rgba(158,79,98,.08)}.mt-tab.on{background:#fff;color:#2a1e22;border-color:rgba(42,30,34,.12);box-shadow:0 -2px 6px -4px rgba(42,30,34,.2);margin-bottom:-1px;padding-bottom:1px}' +
      '.mt-tab .mt-t{overflow:hidden;text-overflow:ellipsis}.mt-tab.home{padding-right:14px}' +
      '.mt-x{border:0;background:none;width:22px;height:22px;border-radius:50%;cursor:pointer;color:inherit;font-size:14px;line-height:1;display:inline-flex;align-items:center;justify-content:center}.mt-x:hover{background:rgba(42,30,34,.1)}' +
      '#mutos-frames{position:fixed;left:0;right:0;bottom:0;z-index:1150;background:var(--bg,#fbf6f2)}#mutos-frames[hidden]{display:none}' +
      '#mutos-frames iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:var(--bg,#fbf6f2)}#mutos-frames iframe[hidden]{display:none}';
    document.head.appendChild(st);
    strip = document.createElement('nav'); strip.id = 'mutos-tabs'; strip.setAttribute('aria-label', 'Open pages');
    frames = document.createElement('div'); frames.id = 'mutos-frames'; frames.hidden = true;
    const bar = document.getElementById('mutos-bar');
    if (bar && bar.parentNode) bar.after(strip); else document.body.insertBefore(strip, document.body.firstChild);
    document.body.appendChild(frames);
    const place = () => { const r = strip.getBoundingClientRect(); frames.style.top = Math.max(0, Math.round(r.bottom)) + 'px'; };
    new ResizeObserver(place).observe(strip); window.addEventListener('resize', place); window.addEventListener('scroll', place, { passive: true });
    setInterval(place, 1000); place();
  }
  function draw() {
    if (!strip) return;
    strip.hidden = !tabs.length || !wide();
    strip.innerHTML = '<button type="button" class="mt-tab home' + (active === 'home' ? ' on' : '') + '" data-tab="home" title="Home and the shoot board">🏠 <span class="mt-t">Home &amp; Board</span></button>' +
      tabs.map(t => '<span role="button" tabindex="0" class="mt-tab' + (active === t.id ? ' on' : '') + '" data-tab="' + t.id + '" title="' + t.title.replace(/"/g, '&quot;') + '"><span class="mt-t">' + t.title.replace(/</g, '&lt;') + '</span><button type="button" class="mt-x" data-close="' + t.id + '" aria-label="Close ' + t.title.replace(/"/g, '&quot;') + '">✕</button></span>').join('');
    strip.querySelectorAll('[data-tab]').forEach(b => {
      b.addEventListener('click', e => { if (e.target.closest('[data-close]')) return; show(b.dataset.tab); });
      b.addEventListener('auxclick', e => { if (e.button === 1 && b.dataset.tab !== 'home') { e.preventDefault(); close(b.dataset.tab); } });
      b.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(b.dataset.tab); } });
    });
    strip.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); close(b.dataset.close); }));
  }
  function frameOf(t) {
    if (!t.frame) {
      t.frame = document.createElement('iframe'); t.frame.title = t.title; t.frame.src = t.url; t.frame.dataset.tab = t.id;
      t.frame.addEventListener('load', () => {
        try { const d = t.frame.contentDocument, x = pageOf(t.frame.contentWindow.location.href); if (x) { t.url = x.pathname + x.search; t.path = x.pathname; t.title = label(x); }
          if (d && d.title && !/^Muto/.test(d.title)) t.title = t.title || d.title; } catch (e) {}
        draw(); save();
      });
      frames.appendChild(t.frame);
    }
    return t.frame;
  }
  function show(id) {
    ensureUi();
    active = tabs.some(t => t.id === id) ? id : 'home';
    tabs.forEach(t => { if (t.frame) t.frame.hidden = t.id !== active; });
    const t = tabs.find(x => x.id === active);
    if (t) { frameOf(t).hidden = false; frames.hidden = false; try { t.frame.contentWindow.focus(); } catch (e) {} }
    else frames.hidden = true;
    document.documentElement.classList.toggle('mutos-in-tab', !!t);
    draw(); save();
  }
  function close(id) {
    const i = tabs.findIndex(t => t.id === id); if (i < 0) return;
    const [t] = tabs.splice(i, 1); if (t.frame) t.frame.remove();
    if (active === id) show(tabs[i] ? tabs[i].id : tabs[i - 1] ? tabs[i - 1].id : 'home'); else { draw(); save(); }
  }
  // open an app page in a tab: the same page already open → switch to it (and go to the new address if it differs)
  function open(url, opts) {
    const x = pageOf(url); if (!isAppPage(x)) return false;
    if (!wide()) return false;
    ensureUi();
    const want = x.pathname + x.search + x.hash;
    let t = tabs.find(y => y.path === x.pathname && (!new URLSearchParams(x.search).get('preview') === !new URLSearchParams(y.url.split('?')[1] || '').get('preview')));
    if (t) {
      if (t.url !== want && !(opts && opts.keep)) { t.url = want; if (t.frame) { try { t.frame.contentWindow.location.href = want; } catch (e) { t.frame.src = want; } } }
    } else {
      t = { id: 't' + (++seq), url: want, path: x.pathname, title: label(x) };
      tabs.push(t);
    }
    if (!(opts && opts.background)) {
      // the Home desk panel / Settings sheet that opened it closes (the page is in its tab now)
      ['#mh-desk .mh-x', '#mh-more .mh-x'].forEach(q => { const x = document.querySelector(q); if (x) x.click(); });
      show(t.id);
    } else { draw(); save(); }
    return true;
  }

  // the studio's own top bar (Home, Board, Work, Gear, Clients, People, Team updates, Settings) works on the studio page:
  // used while another tab is showing, it brings the Home & Board tab back first
  document.addEventListener('click', e => {
    if (active === 'home' || !e.target.closest) return;
    const bar = e.target.closest('#mutos-bar'); if (!bar || e.target.closest('#mutos-back, #mutos-reload')) return;
    show('home');
  }, true);
  // links and buttons on the main page that would leave it open a tab instead
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]'); if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    if (open(a.getAttribute('href'))) e.preventDefault();
  }, true);
  const assign = location.assign.bind(location);
  window.MUTOS_GO = url => { if (!open(url)) assign(url); };   // home.js / team-updates.js use it for buttons that move to another page

  window.MUTOS_TABS = { open, show, close, home: () => show('home'), list: () => tabs.map(t => ({ id: t.id, url: t.url, title: t.title })), active: () => active, wide };
  // the tabs come back after a reload (the page in each loads when you open it)
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (s && s.tabs && s.tabs.length && wide()) {
      const go = () => { s.tabs.forEach(t => open(t.url, { background: true })); if (s.active !== 'home' && tabs[s.active]) show(tabs[s.active].id); };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(go, 300)); else setTimeout(go, 300);
    }
  } catch (e) {}
  window.addEventListener('resize', () => { if (!wide() && active !== 'home') show('home'); draw(); });
})();
