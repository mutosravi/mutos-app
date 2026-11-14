// Supabase project for the Muto's app (project "Mutos App") (Project Settings → API Keys).
// This is the PUBLISHABLE key, which is safe in a public page: the privacy rules in the database decide what each login can see.
// Never put the secret key here.
window.MUTOS_CONFIG = {
  supabaseUrl: 'https://plbixpdyxpayyzpzrvna.supabase.co',
  supabaseAnonKey: 'sb_publishable_BBsRicVGu4a7qv0Xv__3cA_5b8DLUQm',
  // public half of the studio's notification key (the private half is a Cloudflare secret)
  vapidPublicKey: 'BJCKtk7u3gQAIOhyRnGEL8---r-dNvatX1ygGSAzDyLPRtSsAZ67eZKQyVoh3OkCIsekKk74a1BDL010AqCjlhI' // phone reminders (public half; the private half is the Cloudflare secret VAPID_PRIVATE_KEY)
};

// The app's address is app.mutosstudio.com. A page opened on the old workers.dev address (an old link, or Google sign-in
// coming back there) moves to the same page on app.mutosstudio.com, keeping the sign-in that rides in the #… part.
// Otherwise a Home Screen app on iPhone shows it in a browser overlay. (localhost tests are not affected.)
window.MUTOS_CONFIG.home = 'https://app.mutosstudio.com';
if (/\.workers\.dev$/i.test(location.hostname)) location.replace(window.MUTOS_CONFIG.home + location.pathname + location.search + location.hash);

// Suggestions UNDER the box (14 Nov 2026, Ravi: "I needed suggestions but just under the box not above it … click somewhere at
// blank space to make it invisible"). Phones show a box's suggestion list (datalist) in the bar above the keyboard, so the browser's
// own suggestions are turned off and the app draws its own list right under the box:
//   · a box with a list (venues, names, vendors… that the board / pages give in a <datalist>), and
//   · any text box: what was typed in that same box before on this phone (up to 20, kept only on this phone).
// Tap a suggestion to fill it; tap anywhere else (or Esc) to hide it. Arrow keys + Enter work on a computer.
(function () {
  const KEY = 'mutos-recent', MAXR = 20;
  const skipType = /^(email|password|tel|number|date|time|datetime-local|month|week|search|url|checkbox|radio|file|range|color|hidden|submit|button)$/i;
  let recent = {}; try { recent = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { recent = {}; }
  const fieldKey = el => { const k = el.id || el.name || (el.dataset && el.dataset.f) || el.placeholder; return k ? location.pathname + '|' + k : null; };
  const usable = el => el && el.tagName === 'INPUT' && !skipType.test(el.type || 'text') && !el.readOnly && !el.disabled && !el.classList.contains('codein') && el.dataset.nosuggest == null && !/(^|-)q$/.test(el.id || '')   /* search boxes */
    && (!el.getAttribute('autocomplete') || el.getAttribute('autocomplete') === 'off');
  function remember(el) {
    const k = fieldKey(el), v = String(el.value || '').trim();
    if (!k || !v || v.length > 80) return;
    recent[k] = [v].concat((recent[k] || []).filter(x => x.toLowerCase() !== v.toLowerCase())).slice(0, MAXR);
    try { localStorage.setItem(KEY, JSON.stringify(recent)); } catch (e) {}
  }
  let box = null, cur = null, items = [], at = -1;
  function listOf(el) {
    const id = el.getAttribute('list'); if (id) { el.dataset.slist = id; el.removeAttribute('list'); }   // no native list (it shows above the keyboard)
    const dl = el.dataset.slist && document.getElementById(el.dataset.slist);
    const fromList = dl ? [...dl.querySelectorAll('option')].map(o => o.value || o.textContent).filter(Boolean) : [];
    return (recent[fieldKey(el)] || []).concat(fromList);
  }
  function hide() { if (box) box.hidden = true; items = []; at = -1; }
  function place() {
    if (!box || box.hidden || !cur || !document.contains(cur)) return hide();
    const r = cur.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return hide();
    const below = innerHeight - r.bottom - 8, h = Math.min(264, Math.max(120, below));
    box.style.left = Math.max(8, r.left) + 'px'; box.style.width = Math.min(r.width, innerWidth - 16) + 'px'; box.style.maxHeight = h + 'px';
    box.style.top = (below >= 120 ? r.bottom + 4 : Math.max(8, r.top - h - 4)) + 'px';   // under the box; above only if there is no room
  }
  function show(el) {
    cur = el;
    const q = String(el.value || '').trim().toLowerCase(), seen = new Set();
    items = listOf(el).filter(v => { const l = String(v).toLowerCase(); if (seen.has(l)) return false; seen.add(l); return (!q || l.includes(q)) && l !== q; }).slice(0, 8);
    if (!items.length) return hide();
    if (!box) {
      box = document.createElement('div'); box.id = 'mutos-suggest'; box.setAttribute('role', 'listbox');
      box.style.cssText = 'position:fixed;z-index:2147483000;background:#fff;color:#2b1d22;border:1px solid #ead9d2;border-radius:14px;box-shadow:0 10px 30px rgba(40,20,25,.18);overflow:auto;-webkit-overflow-scrolling:touch;font:16px/1.3 -apple-system,system-ui,"Open Sans",sans-serif';
      // pointerdown + preventDefault: the box keeps the focus, so the tap fills it instead of closing first
      box.addEventListener('pointerdown', e => { e.preventDefault(); const b = e.target.closest('[data-i]'); if (b) pick(+b.dataset.i); });
      document.body.appendChild(box);
    }
    at = -1;
    box.innerHTML = items.map((v, i) => '<div role="option" data-i="' + i + '" style="padding:12px 14px;cursor:pointer;border-top:' + (i ? '1px solid #f3e8e3' : '0') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])) + '</div>').join('');
    box.hidden = false; place();
  }
  function mark() { if (box) box.querySelectorAll('[data-i]').forEach(d => { d.style.background = +d.dataset.i === at ? '#f8ece7' : ''; }); }
  function pick(i) {
    if (!cur || items[i] == null) return;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(cur, items[i]);
    cur.dispatchEvent(new Event('input', { bubbles: true })); cur.dispatchEvent(new Event('change', { bubbles: true }));
    hide();
  }
  const start = () => {
    off(document);
    new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType !== 1) return; if (/^(INPUT|TEXTAREA)$/.test(n.tagName) && !n.hasAttribute('autocomplete')) n.setAttribute('autocomplete', 'off'); else off(n); }))).observe(document.documentElement, { childList: true, subtree: true });
    // after the page's own focus handlers (the board fills its lists on focus)
    document.addEventListener('focusin', e => { const el = e.target; if (usable(el)) setTimeout(() => { if (document.activeElement === el) show(el); }, 0); else hide(); });
    document.addEventListener('input', e => { if (e.target === cur && e.isTrusted !== false) show(cur); });
    document.addEventListener('focusout', e => { if (e.target === cur) setTimeout(() => { if (document.activeElement !== cur) hide(); }, 150); });
    document.addEventListener('pointerdown', e => { if (box && !box.hidden && e.target !== cur && !box.contains(e.target)) hide(); }, true);   // tap on blank space
    document.addEventListener('change', e => { if (usable(e.target)) remember(e.target); }, true);
    document.addEventListener('keydown', e => {
      if (!box || box.hidden || e.target !== cur) return;
      if (e.key === 'Escape') { hide(); e.stopPropagation(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { at = (at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length; mark(); e.preventDefault(); }
      else if (e.key === 'Enter' && at >= 0) { pick(at); e.preventDefault(); }
    }, true);
    addEventListener('scroll', place, true); addEventListener('resize', place);
    if (window.visualViewport) visualViewport.addEventListener('resize', place);
  };
  // the browser's own suggestions stay off (they would show above the keyboard again); boxes with their own value keep it
  function off(root) { if (!root || !root.querySelectorAll) return; root.querySelectorAll('input:not([autocomplete]), textarea:not([autocomplete])').forEach(el => { el.setAttribute('autocomplete', 'off'); }); }
  window.MUTOS_SUGGEST = { show, hide, remember, _recent: () => recent };
  // phones and tablets only: on a computer the browser already shows its list under the box, so it is left as it is
  if (!(window.matchMedia && matchMedia('(hover: none) and (pointer: coarse)').matches)) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
