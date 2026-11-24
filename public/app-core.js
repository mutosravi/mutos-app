// Shared sign-in helpers for every page of the team app.
(function () {
  const cfg = window.MUTOS_CONFIG || {};
  let clientP = null;
  function client() {
    if (window.__mutosTestClient) { const t = window.__mutosTestClient; if (!t.__watched) { t.__watched = 1; watchSignIn(t); } return Promise.resolve(t); } // used by tests only
    if (!clientP) clientP = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.1/+esm')
      .then(m => { const c = m.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }); watchSignIn(c); return c; });
    return clientP;
  }
  // The sign-in can end on its own: Supabase renews it in the background, and when a renewal fails (a phone that slept for long,
  // no network at that moment) the session is cleared. The page kept showing everything while every read then went out signed out
  // ("permission denied for table client_links", 24 Nov 2026). Now: wait a moment (another tab or window may have renewed it), then
  // say so plainly with a one-tap "Sign in again" that comes back to this page.
  let leaving = false, warned = false;
  function signedOutBar() {
    if (warned || leaving || !document.body) return; warned = true;
    const bar = document.createElement('div'); bar.id = 'mutos-signedout'; bar.setAttribute('role', 'alert');
    bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:3000;background:#2a1e22;color:#fff;border-radius:16px;padding:14px 16px;display:flex;gap:12px;align-items:center;justify-content:space-between;box-shadow:0 10px 30px rgba(0,0,0,.25);font:600 14px/1.35 system-ui,-apple-system,sans-serif';
    bar.innerHTML = '<span>You were signed out. Nothing you saved is lost.</span><button type="button" style="flex:0 0 auto;border:0;border-radius:999px;background:#fff;color:#2a1e22;font:700 14px system-ui,-apple-system,sans-serif;padding:10px 16px;cursor:pointer">Sign in again</button>';
    bar.querySelector('button').addEventListener('click', () => { try { sessionStorage.setItem('mutos-return', location.pathname + location.search + location.hash); } catch (e) {} signIn(); });
    document.body.appendChild(bar);
  }
  function watchSignIn(c) {
    if (!c.auth || !c.auth.onAuthStateChange) return;
    let had = false;
    c.auth.getSession().then(r => { had = !!(r.data && r.data.session); }).catch(() => {});
    c.auth.onAuthStateChange((ev, s) => {
      if (s) { had = true; warned = false; const b = document.getElementById('mutos-signedout'); if (b) b.remove(); return; }
      if (ev !== 'SIGNED_OUT' || !had || leaving) return;
      setTimeout(async () => { try { const r = await c.auth.getSession(); if (r.data && r.data.session) return; } catch (e) {} signedOutBar(); }, 1500);
    });
    // a phone coming back to the front: make sure the sign-in is still good (renews it when it is due)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') c.auth.getSession().catch(() => {}); });
  }
  // a read refused because nobody is signed in: the plain words for it
  async function whyRefused(e) {
    const msg = String((e && (e.message || e)) || '');
    if (!/permission denied|JWT|not authenticated/i.test(msg)) return null;
    const s = await session().catch(() => null);
    if (!s) { signedOutBar(); return 'You were signed out. Tap "Sign in again".'; }
    return null;
  }
  async function session() { const c = await client(); const { data } = await c.auth.getSession(); return data && data.session; }
  // who is signed in, and what the database says they are: owner, manager, crew, or nobody (null role)
  async function me() {
    const s = await session(); if (!s) return null;
    const c = await client();
    const email = String(s.user.email || '').toLowerCase();
    const { data, error } = await c.from('members').select('email, role, person_key, display_name').eq('email', email).maybeSingle();
    if (error) throw error;
    return { user: s.user, email, name: (s.user.user_metadata && (s.user.user_metadata.full_name || s.user.user_metadata.name)) || email, role: data ? data.role : null, personKey: data ? data.person_key : null };
  }
  // prompt=select_account: Google always shows the account list, so after signing out you can pick a different Gmail
  async function signIn() { const c = await client(); await c.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + '/', queryParams: { prompt: 'select_account' } } }); }
  async function signOut() {
    leaving = true;
    const c = await client();
    try { await c.auth.signOut(); } catch (e) {}
    try { Object.keys(localStorage).filter(k => k.startsWith('sb-')).forEach(k => localStorage.removeItem(k)); } catch (e) {} // also when offline
    location.replace('/');
  }
  // each login type's first page
  const HOME = { owner: '/board.html', manager: '/board.html', supervisor: '/board.html', crew: '/me.html', gear: '/gear.html', staff: '/me.html', accountant: '/attendance.html', kiosk: '/office.html' };
  const homeFor = role => HOME[role] || '/';
  window.mutosApp = { client, session, me, signIn, signOut, homeFor, whyRefused, config: cfg };
})();
