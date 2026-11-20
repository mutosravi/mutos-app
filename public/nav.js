// Going back, everywhere in the studio app (20 Nov 2026, Ravi: "There must be always a back button on any page. No page should
// take to home or desk's home when pressed back. It must always go back only.")
//   · a "‹ Back" button at the start of every page's top bar (header.hdr or the Home bar #mutos-bar): it closes an open window or
//     sheet first, else goes to the page you came from; only when you came from nowhere in the app does it go to your first page
//   · the phone's back gesture / browser Back closes an open window or sheet instead of leaving the page (each open window adds one
//     step to the history; closing it with its own button takes that step away again)
//   · coming Back to the studio Home from a page opened from a desk reopens that desk (home.js calls MUTOS_NAV.deskLeft / deskBack)
// Families (client.html), the sign-in page and the office kiosk do not load this.
(function () {
  const OPEN = '.sheet-bg, .sb-modal-overlay, #att-profile, #photo-view';
  let role = null, pushed = false, ignore = 0, leaving = false;
  window.addEventListener('beforeunload', () => { leaving = true; });
  window.addEventListener('pageshow', () => { leaving = false; });
  const openOnes = () => [...document.querySelectorAll(OPEN)].filter(el => el.isConnected && getComputedStyle(el).display !== 'none');
  const sameOrigin = u => { try { return new URL(u).origin === location.origin; } catch (e) { return false; } };
  const fromApp = () => !!document.referrer && sameOrigin(document.referrer) && !/\/(index\.html)?$/.test(new URL(document.referrer).pathname);
  let moved = false;   // a step taken inside this page (Home ⇄ Board)
  const homePath = () => (window.mutosApp && role ? window.mutosApp.homeFor(role) : '/');
  const onHome = () => location.pathname === homePath() && !location.hash;
  const canBack = () => history.length > 1 && (fromApp() || moved);

  // close the top window / sheet the way its own buttons would
  function closeTop() {
    const list = openOnes(), top = list[list.length - 1]; if (!top) return false;
    // a window's own "← Back" first (it goes to the window before), then its close / cancel
    const x = ['[id$="-back"]', '.mh-x', '#dclose', '[id$="-cx"]', '[id$="-close"]', '[id$="-x"]', '#cl-done', '[id$="-done"]', '.ap-close'].map(q => top.querySelector(q)).find(Boolean);
    if (x) x.click(); else if (top.id === 'sb-active-modal') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    else top.remove();
    if (top.isConnected) top.remove();
    return true;
  }
  function back() {
    if (closeTop()) return;
    if (canBack()) { history.back(); return; }
    if (!onHome()) location.href = homePath();
  }

  // one history step while something is open, so Back closes it
  let t = 0;
  function reconcile() {
    clearTimeout(t);
    t = setTimeout(() => {
      const any = openOnes().length > 0;
      if (any && !pushed) { history.pushState({ mutosSheet: 1 }, '', location.href); pushed = true; }
      else if (!any && pushed) {
        pushed = false;
        if (!leaving && history.state && history.state.mutosSheet) { ignore++; history.back(); }   // take our step away again (only if nothing moved on since)
      }
      paint();
    }, 30);
  }
  window.addEventListener('popstate', e => {
    if (ignore) { ignore--; return; }
    if (pushed) {   // Back while a window was open: close it, stay here
      pushed = false; closeTop(); reconcile(); return;
    }
    if (e.state && e.state.mutosSheet && !openOnes().length) { ignore++; history.back(); return; }   // a leftover step: skip it
    moved = true; paint();
  }, true);
  window.addEventListener('hashchange', () => { moved = true; paint(); });
  new MutationObserver(reconcile).observe(document.documentElement, { childList: true, subtree: true });

  // the button
  function paint() {
    const b = document.getElementById('mutos-back'); if (!b) return;
    b.hidden = !openOnes().length && !canBack() && onHome();
  }
  function mount() {
    const host = document.querySelector('#mutos-bar, header.hdr');
    if (!host) return false;
    if (document.getElementById('mutos-back')) return true;
    const b = document.createElement('button');
    b.type = 'button'; b.id = 'mutos-back'; b.className = 'mutos-back'; b.setAttribute('aria-label', 'Back'); b.innerHTML = '<span aria-hidden="true">‹</span> Back';
    b.addEventListener('click', back);
    host.insertBefore(b, host.firstChild);
    paint(); return true;
  }
  const style = document.createElement('style');
  style.textContent = '.mutos-back{display:inline-flex;align-items:center;gap:4px;min-height:36px;padding:0 12px 0 8px;margin-right:6px;border:0;border-radius:999px;background:#fff;box-shadow:0 1px 3px rgba(42,30,34,.12);color:#2a1e22;font:600 14px/1 inherit;cursor:pointer;flex:0 0 auto}.mutos-back span{font-size:22px;line-height:1;margin-top:-2px}.mutos-back[hidden]{display:none}';
  document.head.appendChild(style);
  function start() { if (!mount()) { let n = 0; const iv = setInterval(() => { if (mount() || ++n > 100) clearInterval(iv); }, 100); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  if (window.mutosApp) window.mutosApp.me().then(m => { role = m && m.role; paint(); }).catch(() => {});

  // desks on the studio Home: remember the desk a page was opened from, reopen it when coming Back
  const KEY = 'mutos-desk-return';
  window.MUTOS_NAV = {
    back, canBack,
    deskLeft(k) { try { sessionStorage.setItem(KEY, JSON.stringify({ k, at: Date.now() })); } catch (e) {} },
    deskBack() {
      try {
        const nav = performance.getEntriesByType('navigation')[0], v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
        sessionStorage.removeItem(KEY);
        return v && nav && nav.type === 'back_forward' && Date.now() - v.at < 6 * 3600e3 ? v.k : null;
      } catch (e) { return null; }
    }
  };
})();
