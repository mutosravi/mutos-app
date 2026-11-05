// Browser half of the test double for Supabase: every query is handed to the test runner (window.__mockCall),
// which holds the tables and applies the same access rules as supabase/schema.sql.
(function () {
  const call = d => window.__mockCall(JSON.parse(JSON.stringify(d)));
  function builder(table) {
    const d = { table, op: 'select', filters: [], order: [], range: null, limit: null, single: false, rows: null };
    const b = {
      select() { return b; },
      eq(col, v) { d.filters.push(['eq', col, v]); return b; },
      in(col, v) { d.filters.push(['in', col, v]); return b; },
      gte(col, v) { d.filters.push(['gte', col, v]); return b; },
      lte(col, v) { d.filters.push(['lte', col, v]); return b; },
      update(fields) { d.op = 'update'; d.rows = [fields]; return b; },
      order(col, o) { d.order.push([col, !o || o.ascending !== false]); return b; },
      range(a, z) { d.range = [a, z]; return b; },
      limit(n) { d.limit = n; return b; },
      maybeSingle() { d.single = true; return b; },
      upsert(rows) { d.op = 'upsert'; d.rows = Array.isArray(rows) ? rows : [rows]; return b; },
      insert(rows) { d.op = 'insert'; d.rows = Array.isArray(rows) ? rows : [rows]; return b; },
      delete() { d.op = 'delete'; return b; },
      then(res, rej) { return call(d).then(res, rej); }
    };
    return b;
  }
  const rt = [];
  window.__rtFire = p => rt.forEach(f => { try { f(p); } catch (e) { console.error(e); } });
  window.__mutosTestClient = {
    from: builder,
    rpc(fn, args) { return call({ op: 'rpc', fn, args: args || {} }); },
    auth: {
      async getSession() { const u = await window.__mockCall({ op: 'session' }); return { data: { session: u ? { user: u, access_token: 'test-token' } : null } }; },
      async signInWithOAuth() { await window.__mockCall({ op: 'signin' }); location.href = '/'; },
      async signOut() { await window.__mockCall({ op: 'signout' }); }
    },
    channel() { const ch = { on(ev, filter, cb) { rt.push(cb); return ch; }, subscribe(cb) { if (cb) setTimeout(() => cb('SUBSCRIBED'), 0); return ch; } }; return ch; }
  };
})();
