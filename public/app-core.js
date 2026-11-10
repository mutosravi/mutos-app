// Shared sign-in helpers for every page of the team app.
(function () {
  const cfg = window.MUTOS_CONFIG || {};
  let clientP = null;
  function client() {
    if (window.__mutosTestClient) return Promise.resolve(window.__mutosTestClient); // used by tests only
    if (!clientP) clientP = import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.110.1/+esm')
      .then(m => m.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }));
    return clientP;
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
    const c = await client();
    try { await c.auth.signOut(); } catch (e) {}
    try { Object.keys(localStorage).filter(k => k.startsWith('sb-')).forEach(k => localStorage.removeItem(k)); } catch (e) {} // also when offline
    location.replace('/');
  }
  // each login type's first page
  const HOME = { owner: '/board.html', manager: '/board.html', supervisor: '/board.html', crew: '/crew.html', gear: '/gear.html', staff: '/work.html', accountant: '/attendance.html', kiosk: '/office.html' };
  const homeFor = role => HOME[role] || '/';
  window.mutosApp = { client, session, me, signIn, signOut, homeFor, config: cfg };
})();
