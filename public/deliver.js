// Editors hand over finished work (27 Nov 2026, Ravi): the file goes from this browser straight to the studio's Google Drive,
// in pieces (a dropped connection resumes from the last piece). worker/deliver.js opens the upload; supabase/047_job_handover.sql
// keeps the rules. window.MutosDeliver = { upload, handover, peek, share, CHUNK }
(function () {
  const CHUNK = 16 * 1024 * 1024;   // a multiple of 256 KB, as Google asks
  async function token(c) { const s = await c.auth.getSession(); const t = s && s.data && s.data.session && s.data.session.access_token; if (!t) throw new Error('Sign in again.'); return t; }
  async function api(c, path, body) {
    const r = await fetch(path, { method: 'POST', headers: { Authorization: 'Bearer ' + await token(c), 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error(d.error || ('The server said ' + r.status));
    return d;
  }
  // one piece; resolves { done, id?, next } (next = the first byte Google does not have yet)
  function put(url, file, start, end, onBytes) {
    return new Promise((ok, no) => {
      const x = new XMLHttpRequest(); x.open('PUT', url);
      if (end > start) x.setRequestHeader('Content-Range', 'bytes ' + start + '-' + (end - 1) + '/' + file.size);
      else x.setRequestHeader('Content-Range', 'bytes */' + file.size);   // "how much do you have?"
      x.upload.onprogress = e => onBytes && onBytes(start + e.loaded);
      x.onload = () => {
        if (x.status === 200 || x.status === 201) { let d = {}; try { d = JSON.parse(x.responseText); } catch (e) {} ok({ done: true, id: d.id }); return; }
        if (x.status === 308) { const rg = x.getResponseHeader('Range'); ok({ done: false, next: rg ? Number(rg.split('-')[1]) + 1 : end > start ? end : null }); return; }
        no(new Error('Google Drive refused the upload (' + x.status + ').'));
      };
      x.onerror = () => no(new Error('network'));
      x.send(end > start ? file.slice(start, end) : null);
    });
  }
  // the whole file; returns the upload id (supabase uploads row)
  async function upload(c, job, file, onProgress) {
    if (!file || !file.size) throw new Error('Pick the file first.');
    const b = await api(c, '/api/deliver/begin', { job, name: file.name, mime: file.type || 'application/octet-stream', size: file.size });
    let at = 0, tries = 0, fileId = null;
    const tell = n => onProgress && onProgress(Math.min(n, file.size), file.size);
    while (!fileId) {
      try {
        const step = (window.MutosDeliver && window.MutosDeliver.CHUNK) || CHUNK;
        const r = await put(b.upload_url, file, at, Math.min(at + step, file.size), tell);
        if (r.done) { fileId = r.id; break; }
        at = r.next; tries = 0; tell(at);
      } catch (e) {
        if (++tries > 6) throw new Error(e.message === 'network' ? 'The connection keeps dropping. Try again on Wi-Fi.' : e.message);
        await new Promise(res => setTimeout(res, Math.min(30000, 1000 * 2 ** tries)));
        try { const q = await put(b.upload_url, file, 0, 0); if (q.done) { fileId = q.id; break; } if (q.next != null) at = q.next; } catch (x) {}   // where to go on from (else the same piece again)
      }
    }
    if (!fileId) throw new Error('The upload did not finish.');
    await api(c, '/api/deliver/done', { id: b.id, file: fileId });
    tell(file.size);
    return b.id;
  }
  async function handover(c, job, opts) {
    const { data, error } = await c.rpc('job_handover', { p_job: job, p_link: opts.link || null, p_upload: opts.upload || null, p_note: opts.note || null });
    if (error) throw new Error(/job_handover/.test(error.message) ? 'Run supabase/047_job_handover.sql in Supabase first.' : error.message);
    if (data && data.error) throw new Error(data.error);
    return data;
  }
  async function peek(c, id) { return (await api(c, '/api/deliver/peek', { id })).url; }
  async function share(c, job) { return (await api(c, '/api/deliver/share', { job })).link; }
  window.MutosDeliver = { upload, handover, peek, share, CHUNK };
})();
