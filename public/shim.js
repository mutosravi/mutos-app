// Gives the shoot board the same storage calls it uses inside Claude, backed by the app's own database.
// Board records live in the "docs" table as (collection, id, data); changes arrive live.
(function () {
  const app = window.mutosApp;
  let ready = null;
  function boot() {
    if (!ready) ready = (async () => {
      const who = await app.me();
      if (!who) { location.href = '/'; throw new Error('signed out'); }
      if (who.role !== 'owner' && who.role !== 'manager' && who.role !== 'supervisor') { location.href = app.homeFor(who.role); throw new Error('not staff'); }
      window.__mutosRole = who.role; // supervisor.js limits what a supervisor can change
      return { who, c: await app.client() };
    })();
    return ready;
  }

  // writes still on their way to the database; leaving the page now would lose them
  let inflight = 0, written = 0;
  function progress() {
    const el = document.getElementById('mutos-saving'); if (!el) return;
    el.hidden = inflight === 0;
    el.textContent = 'Saving to database… ' + written + ' done. Keep this page open.';
    if (inflight === 0) written = 0;
  }
  async function tracked(fn) { inflight++; progress(); try { return await fn(); } finally { inflight--; written++; setTimeout(progress, 0); } }
  window.addEventListener('beforeunload', e => { if (inflight > 0) { e.preventDefault(); e.returnValue = ''; } });
  window.__mutosInflight = () => inflight;

  function dbAdapter(c) {
    const cols = {};
    let channel = null;
    const col = name => (cols[name] = cols[name] || { map: new Map(), subs: [], loaded: false, loading: null });
    const snapOf = name => { const k = col(name); const docs = [...k.map].map(([id, data]) => ({ id, data: () => data, exists: true })); return { docs, size: docs.length, empty: !docs.length, metadata: { fromCache: false, hasPendingWrites: false } }; };
    const fire = name => { const s = snapOf(name); col(name).subs.forEach(sub => { try { sub.next(s); } catch (e) { console.error(e); } }); };
    const timers = {};
    const emit = name => { clearTimeout(timers[name]); timers[name] = setTimeout(() => fire(name), 60); }; // several changes in a row reach the board as one update
    async function fetchAll(name) {
      const m = new Map(); let from = 0; const page = 1000;
      for (;;) {
        const { data, error } = await c.from('docs').select('id, data').eq('collection', name).range(from, from + page - 1);
        if (error) throw error;
        data.forEach(r => m.set(r.id, r.data));
        if (data.length < page) break; from += page;
      }
      return m;
    }
    async function load(name) {
      const k = col(name);
      if (!k.loading) k.loading = (async () => { k.map = await fetchAll(name); k.loaded = true; })();
      return k.loading;
    }
    // Coming back to the app (a phone cuts the live connection in the background), or back online: read everything again,
    // so changes made on another device show without reloading the page. The board merges it with any unsaved change here.
    let lastRefresh = Date.now(), refreshing = false, joined = false;
    async function refreshAll(force) {
      if (refreshing || (!force && Date.now() - lastRefresh < 3000)) return;
      if (inflight > 0) { setTimeout(() => refreshAll(force), 1500); return; } // let this device's own saves land first
      refreshing = true;
      try {
        for (const name of Object.keys(cols)) { const k = cols[name]; if (!k.loaded) continue; k.map = await fetchAll(name); emit(name); }
        lastRefresh = Date.now();
      } catch (e) { console.warn('refresh', e && e.message || e); } finally { refreshing = false; }
    }
    function live() {
      if (channel) return;
      channel = c.channel('board-docs').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, p => {
        const row = (p.new && p.new.collection) ? p.new : p.old; if (!row || !row.collection) return;
        const k = col(row.collection);
        if (p.eventType === 'DELETE') k.map.delete(row.id); else k.map.set(row.id, p.new.data);
        if (k.loaded) emit(row.collection);
      }).subscribe(status => {
        if (status === 'SUBSCRIBED') { if (joined) refreshAll(true); joined = true; } // re-joined: catch up on what was missed
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') Object.values(cols).forEach(k => k.subs.forEach(s => s.error && s.error({ code: 'unavailable', message: 'Live connection lost' })));
      });
    }
    function wake() {
      if (document.hidden) return;
      // a connection that died in the background is replaced by a fresh one
      try { if (channel && channel.state && channel.state !== 'joined' && channel.state !== 'joining' && c.removeChannel) { c.removeChannel(channel); channel = null; live(); } } catch (e) {}
      refreshAll(false);
    }
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('pageshow', e => { if (e.persisted) wake(); });
    window.addEventListener('online', () => refreshAll(true));
    window.addEventListener('focus', wake);
    window.__mutosRefresh = () => refreshAll(true);
    function doc(name, id) {
      return {
        id,
        async get() { const { data, error } = await c.from('docs').select('data').eq('collection', name).eq('id', id).maybeSingle(); if (error) throw error; return { id, exists: !!data, data: () => (data ? data.data : undefined) }; },
        async set(data) {
          // supervisor: a shoot goes through sup_save_event (012), which keeps everything but his itinerary/contact fields as stored
          if (window.__mutosRole === 'supervisor' && name === 'events') {
            const { data: r, error: e1 } = await tracked(() => c.rpc('sup_save_event', { p_id: id, p_data: data }));
            if (e1 || (r && r.error)) throw Object.assign(new Error(e1 ? e1.message : r.error), { code: 'not_granted' });
            col(name).map.set(id, data); if (col(name).loaded) emit(name); return;
          }
          const { error } = await tracked(() => c.from('docs').upsert({ collection: name, id, data })); if (error) throw Object.assign(new Error(error.message), { code: error.code === '42501' ? 'not_granted' : 'unavailable' }); col(name).map.set(id, data); if (col(name).loaded) emit(name); },
        async update(patch) { const cur = await this.get(); return this.set(Object.assign({}, cur.exists ? cur.data() : {}, patch)); },
        async delete() { const { error } = await tracked(() => c.from('docs').delete().eq('collection', name).eq('id', id)); if (error) throw Object.assign(new Error(error.message), { code: 'unavailable' }); col(name).map.delete(id); if (col(name).loaded) emit(name); }
      };
    }
    function query(name, opts) {
      return {
        orderBy(field, dir) { return query(name, Object.assign({}, opts, { order: dir === 'desc' ? 'desc' : 'asc' })); },
        limit(n) { return query(name, Object.assign({}, opts, { limit: n })); },
        async get() {
          let q = c.from('docs').select('id, data').eq('collection', name).order('updated_at', { ascending: opts.order !== 'desc' });
          if (opts.limit) q = q.limit(opts.limit);
          const { data, error } = await q; if (error) throw error;
          const docs = data.map(r => ({ id: r.id, data: () => r.data, exists: true }));
          return { docs, size: docs.length, empty: !docs.length };
        },
        doc: id => doc(name, id),
        onSnapshot(next, error) {
          const k = col(name), sub = { next, error };
          k.subs.push(sub); live();
          load(name).then(() => next(snapOf(name))).catch(e => error && error({ code: 'unavailable', message: String(e && e.message || e) }));
          return () => { k.subs = k.subs.filter(s => s !== sub); };
        }
      };
    }
    return { collection: name => query(name, {}), doc: path => { const [n, id] = String(path).split('/'); return doc(n, id); } };
  }

  function userCap(who) {
    const id = who.user.id;
    return {
      id: async () => id, me: async () => ({ id, name: who.name }),
      isOwner: async () => who.role === 'owner', canEdit: async () => who.role === 'owner' || who.role === 'manager' || who.role === 'supervisor', can: async () => true,
      profiles: async ids => { const o = {}; (ids || []).forEach(x => { o[x] = { name: x === id ? who.name : 'Someone', isMe: x === id }; }); return o; },
      role: who.role, email: who.email
    };
  }

  // The board reads the Team Alignment sheet through "Google Drive"; in the app the server reads it with a service account.
  function driveBridge() {
    return {
      async callTool(server, tool, args) {
        if (tool !== 'download_file_content') throw { code: 'unsupported', message: 'Not available in the team app' };
        const c = await app.client(), s = await c.auth.getSession();
        const r = await fetch('/api/team-sheet', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (s.data.session && s.data.session.access_token) }, body: JSON.stringify({ fileId: args && args.fileId }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw { code: 'tool_error', message: j.error || ('Sheet sync failed (' + r.status + ')') };
        return { payload: { content: j.content } };
      }
    };
  }

  window.claude = {
    use(name) {
      if (name === 'db') return boot().then(b => dbAdapter(b.c));
      if (name === 'user') return boot().then(b => userCap(b.who));
      if (name === 'mcp') return boot().then(() => driveBridge());
      return Promise.resolve(null); // downloads and the rest are not part of the app
    }
  };

  // the header, Home screen and bottom bar are built by home.js
})();
