// Team profile photos (23 Nov 2026, Ravi: "Profile photo?"; 040_team_photos.sql). Needs photos.js (MutosPhotos).
//   MutosTeamPhotos.load(c)            → loads the approved photos once per page (team_photo_map)
//   MutosTeamPhotos.face(name, opts)   → a round face (the approved photo, else the first letter) for a person by board / People name,
//                                        opts { person, size }; call MutosPhotos.fill(root, c) after putting it on the page
//   MutosTeamPhotos.pid(name, person)  → the approved photo's id or ''
//   MutosTeamPhotos.mine(host, c, toast) → "My photo" box for My Profile: current photo, waiting / not approved, Add / Change
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  let byName = {}, byPerson = {}, loading = null;
  const css = document.createElement('style');
  css.textContent = '.tph{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;border-radius:50%;background:#f1e2dc center/cover no-repeat;color:#7d3a4b;font-weight:700;overflow:hidden;vertical-align:middle}' +
    '.tph.pid-ok{color:transparent}.myph{display:flex;align-items:center;gap:14px}.myph .tph{width:72px;height:72px;font-size:26px}.myph small{display:block;color:var(--muted,#6f5f63);margin-top:3px}';
  document.head.appendChild(css);
  async function load(c) {
    if (!loading) loading = c.rpc('team_photo_map').then(({ data }) => {
      (Array.isArray(data) ? data : []).forEach(x => { (x.names || []).forEach(n => { byName[String(n).trim().toLowerCase()] = x.upload; }); if (x.person) byPerson[x.person] = x.upload; });
    }).catch(() => {});
    return loading;
  }
  const pid = (name, person) => (person && byPerson[person]) || byName[String(name || '').trim().toLowerCase()] || '';
  function face(name, o) {
    o = o || {}; const id = o.pid || pid(name, o.person), sz = o.size || 32;
    return '<span class="tph" style="width:' + sz + 'px;height:' + sz + 'px;font-size:' + Math.round(sz * 0.42) + 'px"' + (id ? ' data-pid="' + esc(id) + '"' : '') + ' aria-hidden="true">' +
      esc(String(name || '?').trim().charAt(0).toUpperCase()) + '</span>';
  }
  async function mine(host, c, toast) {
    const P = window.MutosPhotos; if (!host || !P) return;
    let st = {}, drive = {};
    try { const r = await c.rpc('my_team_photo'); if (r.error) { host.hidden = true; return; } st = r.data || {}; } catch (e) { host.hidden = true; return; }
    try { drive = await P.status(c); } catch (e) { drive = {}; }
    const word = { pending: 'Waiting for Muto\'s to approve it', approved: 'Approved: families and the team see it', rejected: 'Not approved' + (st.why ? ': ' + st.why : '') + '. Add another one.' }[st.status] || 'Families see your face on their "Your team" card, once Muto\'s approves it.';
    host.innerHTML = '<div class="myph">' + face('?', { pid: st.upload, size: 72 }) + '<div style="flex:1;min-width:0"><b>My photo</b><small id="tp-st">' + esc(word) + '</small></div></div>' +
      (drive.connected ? '<label class="pillbtn light" style="display:flex;justify-content:center;cursor:pointer;margin-top:10px">' + (st.upload ? '📷 Change photo' : '📷 Add my photo') + '<input type="file" accept="image/*" id="tp-in" hidden></label>'
        : '<p class="meta" style="margin:8px 0 0">Photos are not switched on yet. Ask Ravi to connect Google Drive.</p>');
    P.fill(host, c);
    const inp = host.querySelector('#tp-in');
    if (inp) inp.addEventListener('change', async () => {
      const f = inp.files && inp.files[0]; inp.value = ''; if (!f) return;
      host.querySelector('#tp-st').textContent = 'Uploading…';
      try { await P.upload(c, { kind: 'person', purpose: 'avatar' }, f, { max: 1600, quality: 0.9 }); if (toast) toast('Photo sent. Muto\'s will approve it.'); }
      catch (e) { if (toast) toast(e.message || String(e), true); }
      mine(host, c, toast);
    });
  }
  window.MutosTeamPhotos = { load, face, pid, mine };
  // the studio's board (crew list): MUTOS_APP.face(name) / facesDone(root), photos loaded once the app's client is there
  if (window.mutosApp && !window.MUTOS_APP_FACES) {
    window.MUTOS_APP_FACES = 1;
    const hook = () => {
      const A = window.MUTOS_APP || (window.MUTOS_APP = {});
      A.face = name => pid(name) ? face(name, { size: 22 }) : '';
      A.facesDone = root => { window.mutosApp.client().then(c => { if (window.MutosPhotos) window.MutosPhotos.fill(root, c); }).catch(() => {}); };
    };
    hook(); window.mutosApp.client().then(c => load(c)).then(hook).catch(() => {});
  }
})();
