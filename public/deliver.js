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
  // the Hand over sheet: the editor on My work, and (28 Nov 2026, Ravi: "Give me access to upload files at job too, when client asked
  // for changes and it is done but editor is not available to upload") the admin / manager on the Work desk, who can also send it
  // to the family at once (it is their own check). opts = { W (MutosWork), toast, staff, onDone }
  function sheet(c, j, opts) {
    const W = opts.W, toast = opts.toast, esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    const bg = W.sheet('<h3>' + (opts.staff ? 'Upload the work · ' : 'Hand over · ') + esc(W.jobName(j)) + '</h3><p class="sub">' + esc(j.wedding_title) + (j.round > 1 ? ' · round ' + j.round : '') + '. ' +
        (opts.staff ? 'For when the editor cannot upload it. It is handed over in your name.' : 'Muto\'s checks it before the family sees it.') + '</p>' +
      '<label style="display:block;margin-top:10px;font-weight:600">Upload the file<input class="in" type="file" id="ho-file" style="display:block;width:100%;margin-top:4px"></label>' +
      '<div id="ho-prog" hidden style="margin-top:8px"><div style="height:10px;border-radius:6px;background:var(--surface,#eee);overflow:hidden"><i id="ho-bar" style="display:block;height:100%;width:0;background:var(--rose,#9e4f62)"></i></div><div class="meta" id="ho-pct">Starting…</div></div>' +
      '<p class="meta" style="margin:12px 0 4px">or paste a link (Google Drive), best for full films</p><input class="in" id="ho-link" type="url" placeholder="https://drive.google.com/…" value="' + esc(/^https?:/.test(j.link || '') ? j.link : '') + '" style="width:100%">' +
      '<textarea class="in" id="ho-note" maxlength="300" rows="2" placeholder="' + (opts.staff ? 'Note (optional)' : 'Note for Muto\'s (optional)') + '" style="width:100%;margin-top:10px"></textarea>' +
      (opts.staff ? '<label style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="ho-send" checked style="width:20px;height:20px"> Send it to the family now (already checked)</label>' : '') +
      '<div class="pillrow" style="margin-top:14px"><button type="button" class="pillbtn light" id="ho-x">Close</button><button type="button" class="pillbtn" id="ho-go">' + (opts.staff ? 'Upload' : 'Hand over') + '</button></div>');
    const q = id => bg.querySelector('#' + id); let busy = false;
    q('ho-x').addEventListener('click', () => { if (busy && !confirm('The upload is still going. Stop it?')) return; busy = false; bg.remove(); });
    q('ho-go').addEventListener('click', async () => {
      if (busy) return;
      const f = q('ho-file').files[0], link = q('ho-link').value.trim(), note = q('ho-note').value.trim(), send = !!(q('ho-send') && q('ho-send').checked);
      if (!f && !/^https?:\/\//i.test(link)) { toast('Pick the file, or paste a link that starts with https://', true); return; }
      busy = true; q('ho-go').disabled = true; q('ho-go').textContent = f ? 'Uploading…' : 'Handing over…';
      try {
        let upload = null;
        if (f) {
          q('ho-prog').hidden = false;
          const mb = n => n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : Math.round(n / 1048576) + ' MB';
          upload = await window.MutosDeliver.upload(c, j.id, f, (done, total) => { q('ho-bar').style.width = Math.floor(done / total * 100) + '%'; q('ho-pct').textContent = mb(done) + ' of ' + mb(total) + ' · keep this page open'; });
        }
        await handover(c, j.id, { upload, link: f ? null : link, note });
        let msg = opts.staff ? 'Uploaded. It waits in Clients → Ready to check.' : 'Handed over. Muto\'s will check it and send it to the family.';
        if (opts.staff && send) {
          const { data: now } = await c.from('work_jobs').select('id, delivery, hand_upload').eq('id', j.id).single();
          if (now && now.delivery) {
            const shared = now.hand_upload ? await share(c, j.id) : null;
            const { data, error } = await c.rpc('job_review', { p_job: j.id, p_ok: true, p_note: null, p_link: shared });
            if (error || (data && data.error)) throw new Error('Uploaded, but sending to the family failed: ' + ((data && data.error) || error.message));
            msg = 'Uploaded and sent: ' + W.jobName(j) + ' is Ready on the family\'s page.';
          } else msg = 'Uploaded. It is not linked to a line on the family\'s page yet: open Clients → Ready to check, pick the line and approve.';
        }
        busy = false; bg.remove(); if (opts.onDone) await opts.onDone(); toast(msg);
      } catch (e) { busy = false; q('ho-go').disabled = false; q('ho-go').textContent = opts.staff ? 'Upload' : 'Hand over'; toast(e.message || String(e), true); }
    });
    return bg;
  }
  window.MutosDeliver = { upload, handover, peek, share, sheet, CHUNK };
})();
