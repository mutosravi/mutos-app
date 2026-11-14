// Photos on the studio's Google Drive (14 Nov 2026, Ravi). Shared by cards.html, client.html, crew.html, clients.js and home.js.
// Files go through the Worker straight into Drive (worker/photos.js); Supabase only keeps which Drive file is which (026_photos.sql).
//   MutosPhotos.upload(c, info, file, { max, quality, onProgress })  → { id }   info = { kind:'card'|'client', ref, cards, purpose, event, note }
//   MutosPhotos.url(c, id, small)        → object URL of the photo (or its ~480px copy), cached for this page
//   MutosPhotos.fill(root, c)            → loads every [data-pid] inside root (img src, or background-image)
//   MutosPhotos.view(c, list, i)         → full-screen viewer; list items { pid | photo (old data URL), title, sub }
//   MutosPhotos.status(c) / settings(c)  → is Drive connected; the admin's connect window
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  async function token(c) { const s = await c.auth.getSession(); const t = s && s.data && s.data.session && s.data.session.access_token; if (!t) throw new Error('Sign in again.'); return t; }

  // a smaller JPEG (longest side ≤ max px). Keeps the original when it is already small enough and a JPEG.
  async function shrink(file, max, quality) {
    let bmp = null;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {
      bmp = await new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error('This file is not a photo the phone can open.')); im.src = URL.createObjectURL(file); });
    }
    const w0 = bmp.width || bmp.naturalWidth, h0 = bmp.height || bmp.naturalHeight, k = Math.min(1, max / Math.max(w0, h0));
    if (k === 1 && file.type === 'image/jpeg' && file.size < 8 * 1024 * 1024) return { blob: file, width: w0, height: h0 };
    const w = Math.round(w0 * k), h = Math.round(h0 * k), cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', quality));
    if (!blob) throw new Error('Could not prepare this photo.');
    return { blob, width: w, height: h };
  }
  function post(tok, path, blob, headers, onProgress) {
    return new Promise((ok, bad) => {
      const x = new XMLHttpRequest(); x.open('POST', path);
      x.setRequestHeader('Authorization', 'Bearer ' + tok); x.setRequestHeader('Content-Type', blob.type || 'image/jpeg');
      Object.entries(headers || {}).forEach(([k, v]) => x.setRequestHeader(k, v));
      if (onProgress && x.upload) x.upload.onprogress = e => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch (e) {} if (x.status >= 200 && x.status < 300 && !d.error) ok(d); else bad(new Error(d.error || 'Upload failed (' + x.status + ').')); };
      x.onerror = () => bad(new Error('No internet. Try again.'));
      x.send(blob);
    });
  }
  async function upload(c, info, file, o) {
    o = o || {};
    if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('Only photos can be added.');
    const tok = await token(c), big = await shrink(file, o.max || 3000, o.quality || 0.9);
    if (big.blob.size > 25 * 1024 * 1024) throw new Error('This photo is too big (25 MB at most).');
    const d = await post(tok, '/api/photos/upload', big.blob, { 'X-Mutos-Photo': encodeURIComponent(JSON.stringify(Object.assign({ name: file.name || 'photo' }, info))), 'X-Photo-Width': String(big.width), 'X-Photo-Height': String(big.height) }, o.onProgress);
    try { const sm = await shrink(file, 480, 0.8); await post(tok, '/api/photos/upload?thumb=' + d.id, sm.blob, {}); } catch (e) { /* the full photo is used in lists then */ }
    return d;
  }
  const cache = new Map();
  function url(c, id, small) {
    const key = id + (small ? ':s' : '');
    if (!cache.has(key)) cache.set(key, (async () => {
      const r = await fetch('/api/photos/file/' + id + (small ? '?s=thumb' : ''), { headers: { Authorization: 'Bearer ' + await token(c) } });
      if (!r.ok) { let m = 'Photo not available.'; try { m = (await r.json()).error || m; } catch (e) {} throw new Error(m); }
      return URL.createObjectURL(await r.blob());
    })().catch(e => { cache.delete(key); throw e; }));
    return cache.get(key);
  }
  function fill(root, c) {
    (root || document).querySelectorAll('[data-pid]:not([data-pid-done])').forEach(el => {
      el.setAttribute('data-pid-done', '1');
      url(c, el.dataset.pid, el.dataset.full !== '1').then(u => { if (el.tagName === 'IMG') el.src = u; else el.style.backgroundImage = 'url(' + u + ')'; el.classList.add('pid-ok'); })
        .catch(e => { el.classList.add('pid-bad'); el.title = e.message; });
    });
  }
  // a photo for a list: <img> with a small copy from Drive, or an old photo kept in the form (data URL)
  function img(x, style, alt) {
    if (x && x.pid) return '<img data-pid="' + esc(x.pid) + '" alt="' + esc(alt || '') + '" style="' + style + ';background:#f1e2dc">';
    if (x && x.photo) return '<img src="' + esc(x.photo) + '" alt="' + esc(alt || '') + '" style="' + style + '">';
    return '';
  }
  function view(c, list, i) {
    list = (list || []).filter(x => x && (x.pid || x.photo));
    if (!list.length) return;
    let at = Math.max(0, Math.min(i || 0, list.length - 1)), sx = null;
    const ov = document.createElement('div'); ov.id = 'photo-view'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(20,12,15,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:16px;color:#fff;font-family:inherit';
    const btn = 'border:0;background:rgba(255,255,255,.16);color:#fff;border-radius:999px;font-size:22px;width:48px;height:48px;cursor:pointer';
    const draw = () => { const x = list[at];
      ov.innerHTML = '<button type="button" data-x="close" aria-label="Close" style="' + btn + ';position:absolute;top:calc(14px + env(safe-area-inset-top));right:14px">✕</button>' +
        '<img id="pv-img" alt="' + esc(x.title || '') + '" style="max-width:92vw;max-height:70vh;border-radius:18px;object-fit:contain;background:#000;min-width:120px;min-height:120px"' + (x.photo && !x.pid ? ' src="' + esc(x.photo) + '"' : '') + '>' +
        (x.title ? '<div style="margin-top:14px;font-size:18px;font-weight:700;text-align:center">' + esc(x.title) + '</div>' : '') + (x.sub ? '<div style="opacity:.75;font-size:14px;text-align:center">' + esc(x.sub) + '</div>' : '') +
        (list.length > 1 ? '<div style="display:flex;gap:16px;align-items:center;margin-top:14px"><button type="button" data-x="prev" aria-label="Previous" style="' + btn + '">‹</button><span style="font-size:13px;opacity:.75">' + (at + 1) + ' of ' + list.length + '</span><button type="button" data-x="next" aria-label="Next" style="' + btn + '">›</button></div>' : '');
      if (x.pid) { const im = ov.querySelector('#pv-img'); url(c, x.pid, true).then(u => { if (!im.src) im.src = u; }).catch(() => {}); url(c, x.pid, false).then(u => { im.src = u; }).catch(e => { im.alt = e.message; }); }
    };
    const go = d => { at = (at + d + list.length) % list.length; draw(); };
    const close = () => { ov.remove(); document.removeEventListener('keydown', key); };
    const key = e => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1); };
    ov.addEventListener('click', e => { const x = e.target.closest('[data-x]'); if (x) { if (x.dataset.x === 'close') close(); else go(x.dataset.x === 'next' ? 1 : -1); } else if (e.target === ov) close(); });
    ov.addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
    ov.addEventListener('touchend', e => { if (sx == null) return; const dx = e.changedTouches[0].clientX - sx; sx = null; if (Math.abs(dx) > 50 && list.length > 1) go(dx < 0 ? 1 : -1); });
    document.addEventListener('keydown', key);
    draw(); document.body.appendChild(ov);
  }
  async function api(c, path, method, body) {
    const r = await fetch(path, { method: method || 'GET', headers: { Authorization: 'Bearer ' + await token(c), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    let d = {}; try { d = await r.json(); } catch (e) { d = { error: 'The app server did not answer (' + r.status + ').' }; }
    if (!r.ok && !d.error) d.error = 'Failed (' + r.status + ').';
    return d;
  }
  const status = c => api(c, '/api/photos/status');
  const remove = (c, id) => api(c, '/api/photos/remove', 'POST', { id });
  // the admin's window: connect / disconnect the studio Gmail
  async function settings(c) {
    const ov = document.createElement('div'); ov.id = 'gd-win';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(40,25,30,.45);display:flex;align-items:center;justify-content:center;padding:16px';
    ov.innerHTML = '<div style="background:var(--surface,#fff);color:var(--ink,#2b1d22);border-radius:20px;max-width:440px;width:100%;padding:20px;font-family:inherit;box-shadow:0 20px 60px rgba(0,0,0,.25)">' +
      '<h3 style="margin:0 0 6px">Photos on Google Drive</h3><div id="gd-body" style="font-size:14px;line-height:1.5">Checking…</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px"><button type="button" class="pillbtn" id="gd-go" hidden>Connect Google Drive</button><button type="button" class="pillbtn light" id="gd-off" hidden>Disconnect</button><button type="button" class="pillbtn light" id="gd-x">Close</button></div></div>';
    document.body.appendChild(ov);
    const $ = s => ov.querySelector(s), close = () => ov.remove();
    $('#gd-x').addEventListener('click', close); ov.addEventListener('click', e => { if (e.target === ov) close(); });
    const st = await status(c);
    if (st.error) { $('#gd-body').textContent = st.error; return; }
    $('#gd-body').innerHTML = !st.configured ? 'Not set up yet. In Google Cloud make an OAuth client (Web application) with the redirect address <b>' + esc(location.origin) + '/api/photos/callback</b>, then add <b>GDRIVE_CLIENT_ID</b> and <b>GDRIVE_CLIENT_SECRET</b> in Cloudflare → mutos-app → Settings → Variables and Secrets.'
      : st.connected ? 'Connected ✓ Photos go to the folder <b>Muto\'s app photos</b> in the Drive of <b>' + esc(st.account || '') + '</b>' + (st.since ? ' (since ' + esc(new Date(st.since).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })) + ')' : '') + '.<br><span style="opacity:.7">Card photos: Cards / month. Family photos: Families / wedding. The app can only see the files it made there.</span>'
      : 'Not connected. Tap Connect and sign in with the <b>studio Gmail</b> that should keep the photos (not your personal one). Team and families can add photos once it is connected.';
    $('#gd-go').hidden = !st.configured; $('#gd-go').textContent = st.connected ? 'Connect a different Gmail' : 'Connect Google Drive';
    $('#gd-off').hidden = !st.connected;
    $('#gd-go').addEventListener('click', async () => { const r = await api(c, '/api/photos/connect', 'POST'); if (r.url) location.href = r.url; else $('#gd-body').textContent = r.error || 'Could not start.'; });
    $('#gd-off').addEventListener('click', async () => { if (!confirm('Disconnect Google Drive? Nobody can add or open photos until it is connected again. The photos stay in that Drive.')) return; const r = await api(c, '/api/photos/disconnect', 'POST'); $('#gd-body').textContent = r.error || 'Disconnected.'; $('#gd-off').hidden = true; });
  }
  window.MutosPhotos = { upload, url, fill, img, view, status, remove, settings, shrink, _cache: cache };
})();
