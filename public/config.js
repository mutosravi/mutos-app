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

// No browser suggestions (old entries, saved addresses) under the boxes (14 Nov 2026, Ravi: they covered the page on phones).
// Boxes that ask for one on purpose (autocomplete="…" set in the page) keep it. New boxes (forms drawn later) are covered too.
(function () {
  const off = root => { if (!root || !root.querySelectorAll) return; root.querySelectorAll('input:not([autocomplete]), textarea:not([autocomplete])').forEach(el => { el.setAttribute('autocomplete', 'off'); }); };
  const start = () => { off(document); new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType !== 1) return; if (/^(INPUT|TEXTAREA)$/.test(n.tagName) && !n.hasAttribute('autocomplete')) n.setAttribute('autocomplete', 'off'); else off(n); }))).observe(document.documentElement, { childList: true, subtree: true }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
