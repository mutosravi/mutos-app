// Supervisor login on the board (10 Nov 2026, Ravi): adds new shoots, changes only the itinerary and the client's
// contact on existing ones, deletes only a shoot he added himself in the last hour. Same rules as
// supabase/012_supervisor.sql (the database is the real lock; this keeps his screen honest and puts back what it refuses).
(function () {
  const app = window.mutosApp;
  // keep in step with public.event_edit_fields() in 012_supervisor.sql
  const FIELDS = ['name', 'date', 'slot', 'callTime', 'location', 'mapLink', 'contactName', 'contactPhone', 'notes', 'noteSent'];
  const HOUR = 55 * 60 * 1000;   // a little under the database's hour, so the button never offers what the database refuses
  const NOTE = 'Supervisor: you can add shoots and change the itinerary and the client\'s contact. Crew, gear, coverage, cancelling and deleting are for Ravi or the manager.';
  const KEY = 'mutos-sup-new';
  const isSup = () => window.__mutosRole === 'supervisor';

  // shoots he added, and when (this device, plus what the database says on load)
  let mine = {};
  try { mine = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { mine = {}; }
  const keep = () => { const now = Date.now(); Object.keys(mine).forEach(id => { if (now - mine[id] > HOUR) delete mine[id]; }); try { localStorage.setItem(KEY, JSON.stringify(mine)); } catch (e) {} };
  const canDelete = id => !!mine[id] && Date.now() - mine[id] < HOUR;
  async function loadMine() {
    try {
      const who = await app.me(), c = await app.client();
      const since = new Date(Date.now() - HOUR).toISOString();
      const { data, error } = await c.from('docs').select('id, created_at').eq('collection', 'events').eq('created_by', who.email).gte('created_at', since);
      if (!error) (data || []).forEach(r => { mine[r.id] = Math.min(mine[r.id] || Infinity, Date.parse(r.created_at)); });
      keep();
    } catch (e) { /* only the delete button depends on it */ }
  }

  // the same JSON for the same content, whatever the key order
  const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);
  const strip = o => { const c = Object.assign({}, o); FIELDS.forEach(f => { delete c[f]; }); return stable(c); };
  const hasCrew = ev => (ev.assignments || []).some(a => a.memberId || (a.gearIds || []).length) || (ev.equipmentIds || []).length > 0 || (ev.assistantIds || []).length > 0;
  const WHAT = { shooters: 'the crew list', assistants: 'the assistants', equipment: 'the gear list', unavailability: 'days off', seasons: 'seasons', settings: 'board settings' };

  // true = allowed; a sentence = refused (the board puts the change back and shows the sentence)
  function allowWrite(key, id, before, after) {
    if (!isSup()) return true;
    if (key !== 'events') return 'Only Ravi or the manager can change ' + (WHAT[key] || 'that') + ', so it was put back.';
    if (!after) return canDelete(id) ? true : 'Only Ravi or the manager can delete a shoot (you can delete one you added in the last hour), so it was put back.';
    if (!before) {
      if (hasCrew(after)) return 'New shoots go on the board without crew or gear: Ravi or the manager assigns them. Put back.';
      mine[id] = Date.now(); keep(); return true;
    }
    return strip(before) === strip(after) ? true : 'You can change the itinerary and the client\'s contact. Crew, gear, coverage and cancelling are for Ravi or the manager, so that change was put back.';
  }
  function limits() { return isSup() ? { fields: FIELDS.slice(), canDelete, note: NOTE } : null; }

  // what his board shows: no crew, gear, money or settings controls (the buttons would only be put back)
  function dress() {
    if (!isSup() || document.getElementById('mutos-sup-style')) return;
    document.body.classList.add('mutos-sup');
    const st = document.createElement('style'); st.id = 'mutos-sup-style';
    st.textContent = '.mutos-sup #sb-root [data-action]:not([data-action="edit"]):not([data-action="note"]):not([data-action="addhere"]):not([data-action="schedule"]){display:none!important}' +
      ['#sb-manage-shooters', '#sb-manage-assistants', '#sb-manage-gear', '#sb-billing', '#sb-rentals', '#sb-rent-pill', '#sb-rent-box', '#sb-restore', '#sb-backup', '#sb-export', '#sb-planner', '#sb-workload',
        '#sb-prewed', '#sb-team-inbox', '#sb-inbox-pill', '#sb-team-status', '#sb-team-now', '#sb-crew-status', '#sb-crew-now', '#sb-merge-open', '#sb-empty-load', '#sb-needs-update', '#sb-season']
        .map(s => '.mutos-sup ' + s).join(',') + '{display:none!important}' +
      '.mutos-sup .sb-edit-form .sb-field:disabled,.mutos-sup .sb-edit-form .sb-seg button:disabled{opacity:.45;cursor:not-allowed}';
    document.head.appendChild(st);
  }

  const A = window.MUTOS_APP || (window.MUTOS_APP = {});
  A.allowWrite = allowWrite;
  A.limits = limits;
  window.MUTOS_SUPERVISOR = { FIELDS, allowWrite, limits, canDelete, isSup, _mine: () => mine };
  document.addEventListener('DOMContentLoaded', () => { const t = setInterval(() => { if (window.__mutosRole) { clearInterval(t); if (isSup()) { dress(); loadMine(); } } }, 100); });
})();
