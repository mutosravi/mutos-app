// Muto's app · one employee's attendance profile (12 Nov 2026, Ravi: "How to see attendance profile of an employee?").
// MutosAttProfile.open({ c, emp, shoots, month?, onFix? }) opens a full-screen sheet (owner + accountant, attendance.html):
// month summary, colour calendar (tap a day: in / lunch / out and corrections), habits over 3 months, requests and advances,
// payslips and the salary sheet from before the app. MutosAttProfile.summaryHtml(calc, emp) is also used on the employee's own Month tab.
// Reads only what RLS already allows (payroll roles read everyone; an employee reads their own rows). Needs payroll.js + att-data.js.
(function () {
  const A = () => window.MutosAtt, P = () => window.MutosPay;
  const esc = s => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  const dn = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  const KIND = { in: 'Check-in', lunch_out: 'Lunch out', lunch_in: 'Back from lunch', out: 'Check-out' };

  // counts for one month (from MutosPay.monthCalc) → [label, value, tone]
  function counts(calc, emp) {
    const n = st => calc.days.filter(r => st.includes(r.status)).length;
    const leaveUsed = calc.days.filter(r => r.status === 'leave_paid' || r.status === 'leave').reduce((s, r) => s + (/^Half-day/.test(r.label || '') ? 0.5 : 1), 0);
    const paidUsed = calc.days.filter(r => r.status === 'leave_paid').reduce((s, r) => s + (/^Half-day/.test(r.label || '') ? 0.5 : 1), 0);
    const pl = Number(emp.paid_leave || 0);
    return [
      ['Present', n(['present', 'open']), 'ok'], ['Late', calc.lates, calc.lates >= 3 ? 'bad' : calc.lates ? 'wait' : 'ok'], ['Half days', n(['half']), n(['half']) ? 'wait' : 'ok'],
      ['Short days', n(['short']), 'mute'], ['Leave', leaveUsed, 'mute'], ['Paid leave left', pl ? Math.max(0, pl - paidUsed) + ' of ' + pl : 'none', 'mute'],
      ['Office + shoot', n(['shoot_office']), 'ok'], ['Shoot days', n(['shoot', 'shoot_paid', 'shoot_office']), 'mute'], ['Absent', n(['absent']), n(['absent']) ? 'bad' : 'ok'], ['No check-out', n(['missing']), n(['missing']) ? 'bad' : 'ok']
    ].filter(x => x[0] === 'Present' || x[0] === 'Late' || x[0] === 'Absent' || x[0] === 'Paid leave left' || (typeof x[1] === 'number' ? x[1] > 0 : true));
  }
  const TONE = { ok: ['#dcebe6', '#1f4d43'], wait: ['#f2dfa7', '#5c4410'], bad: ['#fbe2dc', '#7a2d1e'], mute: ['#efe4d6', '#2a1e22'] };
  function summaryHtml(calc, emp) {
    return '<div class="ap-sum" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin-top:10px">' +
      counts(calc, emp).map(([k, v, t]) => '<div style="background:' + TONE[t][0] + ';color:' + TONE[t][1] + ';border-radius:14px;padding:8px 10px"><b style="display:block;font-size:20px;line-height:1.2">' + esc(v) + '</b><span style="font-size:11.5px">' + esc(k) + '</span></div>').join('') +
      '</div>' + (calc.lateCut ? '<p class="sub" style="margin:6px 0 0">' + calc.lateCut + ' day cut for late marks (every 3rd late = ½ day).</p>' : '');
  }

  // average first check-in (minutes after midnight, India time) on office days
  function avgIn(d, email) {
    const first = new Map();
    d.punches.filter(p => p.email === email && p.kind === 'in').forEach(p => { const m = P().istMin(p.at); if (!first.has(p.day) || m < first.get(p.day)) first.set(p.day, m); });
    const v = [...first.values()]; return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  }

  function open(o) {
    const { c, emp } = o, shoots = o.shoots || [], today = A().todayIST();
    let month = o.month || A().monthOf(today), sel = null, d = null, calc = null;
    const bg = document.createElement('div'); bg.className = 'ap-bg'; bg.id = 'att-profile';
    bg.style.cssText = 'position:fixed;inset:0;z-index:60;background:rgba(42,30,34,.45);display:flex;justify-content:center;align-items:flex-end';
    bg.innerHTML = '<div class="ap" role="dialog" aria-modal="true" aria-label="Attendance of ' + esc(emp.name) + '" style="background:var(--bg,#fbf6f2);width:100%;max-width:680px;max-height:96vh;overflow:auto;border-radius:24px 24px 0 0;padding:18px 16px max(20px,env(safe-area-inset-bottom))"></div>';
    document.body.appendChild(bg);
    const box = bg.querySelector('.ap');
    const close = () => { bg.remove(); document.removeEventListener('keydown', key); };
    const key = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', key);
    bg.addEventListener('click', e => { if (e.target === bg) close(); });

    const head = () => '<div style="display:flex;align-items:center;gap:10px"><span class="avatar soft" style="flex:none">' + esc((emp.name || '?').trim().charAt(0).toUpperCase()) + '</span><div style="flex:1;min-width:0"><h3 style="margin:0;font-size:20px">' + esc(emp.name) + '</h3><div class="sub" style="font-size:12.5px">' +
      esc([A().t12(emp.start_time) + ' start', 'off ' + A().WEEK[emp.weekly_off], A().rs(emp.monthly_salary) + '/month', emp.person_key ? 'also shoots (Type ' + emp.shoot_type + ')' : 'office only', emp.joined ? 'joined ' + dn(emp.joined) : '', emp.active ? '' : 'left'].filter(Boolean).join(' · ')) +
      '</div></div><button type="button" class="roundbtn" id="ap-close" aria-label="Close" style="flex:none;font-size:18px">✕</button></div>';

    async function load() {
      box.innerHTML = head() + '<p class="sub" style="margin-top:14px">Loading…</p>'; wire();
      try { d = await A().loadMonth(c, month, [emp.email]); }
      catch (e) { box.innerHTML = head() + '<p class="err">Could not load: ' + esc(e.message) + '</p>'; wire(); return; }
      calc = A().calcFor(emp, d, shoots, { upto: month === A().monthOf(today) ? today : null });
      draw(); habits(); extras();
    }
    function wire() { const x = box.querySelector('#ap-close'); if (x) x.addEventListener('click', close); }

    function draw() {
      const first = new Date(month + '-01T00:00:00Z').getUTCDay(), offset = (first + 6) % 7;
      let cal = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(x => '<span style="font-size:11px;color:var(--muted);text-align:center">' + x + '</span>').join('') + '<span></span>'.repeat(offset);
      P().monthDays(month).forEach(day => {
        const r = calc.days.find(x => x.date === day), s = r ? (A().STATUS[r.status] || ['', '#fff', '#000']) : ['', 'rgba(255,255,255,.5)', '#b9aaae'];
        const fixed = d.punches.some(p => p.email === emp.email && p.day === day && p.by_fix);
        cal += '<button type="button" data-d="' + day + '" title="' + esc(r ? s[0] : '') + '" style="border:0;border-radius:12px;min-height:46px;padding:4px 0;font:700 14px var(--font-body);cursor:pointer;box-shadow:var(--shadow);position:relative;background:' + s[1] + ';color:' + s[2] + (sel === day ? ';outline:2px solid var(--ink)' : '') + '">' + Number(day.slice(8)) +
          '<small style="display:block;font-size:9px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 2px">' + esc(r ? s[0] : '') + '</small>' + (fixed ? '<span title="corrected" style="position:absolute;top:3px;right:5px;font-size:9px">✎</span>' : '') + '</button>';
      });
      const used = new Set(calc.days.map(x => x.status));
      const r = sel && calc.days.find(x => x.date === sel);
      const taps = sel ? d.punches.filter(p => p.email === emp.email && p.day === sel).sort((a, b) => a.at.localeCompare(b.at)) : [];
      box.innerHTML = head() +
        '<div class="sechead" style="margin-top:14px"><button type="button" class="allbtn" id="ap-prev" aria-label="Previous month">‹</button><h2 id="ap-month">' + esc(A().monthLabel(month)) + '</h2><button type="button" class="allbtn" id="ap-next" aria-label="Next month"' + (month >= A().monthOf(today) ? ' disabled' : '') + '>›</button></div>' +
        summaryHtml(calc, emp) +
        '<div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:5px;margin-top:12px" id="ap-cal">' + cal + '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">' + Object.entries(A().STATUS).filter(([k]) => used.has(k)).map(([, s]) => '<span style="font-size:11px;border-radius:999px;padding:3px 9px;background:' + s[1] + ';color:' + s[2] + '">' + esc(s[0]) + '</span>').join('') + '</div>' +
        '<div id="ap-day" style="margin-top:12px">' + (r ? '<div class="card" style="background:var(--surface);border-radius:16px;padding:12px 14px;box-shadow:var(--shadow)"><b>' + esc(r.day + ' · ' + (r.label || '')) + '</b>' + (r.note ? '<div class="sub" style="font-size:12.5px">' + esc(r.note) + '</div>' : '') +
          (taps.length ? '<div style="margin-top:6px;font-size:13.5px;line-height:1.7">' + taps.map(p => esc(KIND[p.kind] || p.kind) + ' <b>' + esc(P().fmtT(P().istMin(p.at))) + '</b>' + (p.by_fix ? ' <span class="pill mute" style="font-size:11px">corrected</span>' : '') + (p.flag ? ' <span class="pill mute" style="font-size:11px">' + esc(String(p.flag).replace(/_/g, ' ')) + '</span>' : '')).join('<br>') + '</div>' : '<div class="sub" style="font-size:12.5px">No taps this day.</div>') + '</div>' : '<p class="sub">Tap a day to see the check-in, lunch and check-out times.</p>') + '</div>' +
        '<div class="sechead" style="margin-top:18px"><h2>Habits · last 3 months</h2></div><div id="ap-habits"><p class="sub">Loading…</p></div>' +
        '<div class="sechead" style="margin-top:18px"><h2>Requests</h2></div><div id="ap-req">' + reqHtml() + '</div>' +
        '<div class="sechead" style="margin-top:18px"><h2>Payslips</h2></div><div id="ap-slips"><p class="sub">Loading…</p></div>';
      wire();
      box.querySelector('#ap-prev').addEventListener('click', () => { month = A().shiftMonth(month, -1); sel = null; load(); });
      box.querySelector('#ap-next').addEventListener('click', () => { if (month < A().monthOf(today)) { month = A().shiftMonth(month, 1); sel = null; load(); } });
      box.querySelectorAll('#ap-cal [data-d]').forEach(b => b.addEventListener('click', () => { sel = b.dataset.d; const keep = { h: box.querySelector('#ap-habits').innerHTML, s: box.querySelector('#ap-slips').innerHTML }; draw(); box.querySelector('#ap-habits').innerHTML = keep.h; box.querySelector('#ap-slips').innerHTML = keep.s; box.querySelector('#ap-day').scrollIntoView({ block: 'nearest' }); }));
    }

    function reqHtml() {
      const rs = d.requests.filter(r => r.email === emp.email).slice(0, 30);
      if (!rs.length) return '<div class="empty">No requests yet.</div>';
      const adv = rs.filter(r => r.kind === 'advance' && r.status === 'approved' && Number(r.amount) - Number(r.recovered || 0) > 0);
      return (adv.length ? '<div class="ans wait" style="margin:0 0 8px">Advance still to recover: <b>' + A().rs(adv.reduce((s, r) => s + Number(r.amount) - Number(r.recovered || 0), 0)) + '</b> (' + adv.map(r => A().rs(r.per_month) + '/month').join(', ') + ')</div>' : '') +
        rs.map(r => {
          const t = r.kind === 'leave' ? (r.half ? 'Half-day leave ' : 'Leave ') + dn(r.day) + (r.day_to && r.day_to !== r.day ? ' → ' + dn(r.day_to) : '')
            : r.kind === 'fix' ? 'Correction ' + dn(r.day) + ': ' + (KIND[r.fix_kind] || r.fix_kind) + ' at ' + A().t12(r.fix_time)
            : 'Advance ' + A().rs(r.amount) + (r.status === 'approved' ? ' · ' + A().rs(Number(r.amount) - Number(r.recovered || 0)) + ' left' : '');
          return '<div class="card" style="background:var(--surface);border-radius:14px;padding:10px 12px;margin:6px 0;box-shadow:var(--shadow);display:flex;justify-content:space-between;gap:10px;align-items:center"><div><b style="font-size:14px">' + esc(t) + '</b><div class="sub" style="font-size:12px">' + esc([r.reason, 'asked ' + dn(String(r.created_at).slice(0, 10)), r.note ? 'reply: ' + r.note : ''].filter(Boolean).join(' · ')) + '</div></div><span class="pill ' + ({ pending: 'wait', approved: 'ok', declined: 'no' }[r.status] || 'mute') + '">' + esc(r.status) + '</span></div>';
        }).join('');
    }

    async function habits() {
      const months = [0, -1, -2].map(n => A().shiftMonth(month, n));
      try {
        const ds = await Promise.all(months.map(m => m === month ? d : A().loadMonth(c, m, [emp.email])));
        const rows = months.map((m, i) => { const k = A().calcFor(emp, ds[i], shoots, { upto: m === A().monthOf(today) ? today : null }); const av = avgIn(ds[i], emp.email);
          return { m, lates: k.lates, absent: k.days.filter(x => x.status === 'absent').length, missing: k.days.filter(x => x.status === 'missing').length, av, paid: k.paidDays, work: k.workingDays }; });
        const el = box.querySelector('#ap-habits'); if (!el) return;
        const start = P().istMin('2000-01-01T' + String(emp.start_time || '10:00').slice(0, 5) + ':00+05:30');
        el.innerHTML = '<div class="tblwrap" style="margin-top:6px"><table class="tbl" style="width:100%"><thead><tr><th>Month</th><th class="n">Avg check-in</th><th class="n">Late</th><th class="n">Absent</th><th class="n">Paid days</th></tr></thead><tbody>' +
          rows.map(r => '<tr><td>' + esc(A().monthLabel(r.m)) + '</td><td class="n">' + (r.av == null ? '–' : esc(P().fmtT(r.av)) + (r.av - start > 15 ? ' <span style="color:#7a2d1e">●</span>' : '')) + '</td><td class="n">' + r.lates + '</td><td class="n">' + r.absent + (r.missing ? ' <span class="sub">+' + r.missing + ' no out</span>' : '') + '</td><td class="n">' + r.paid + ' / ' + r.work + '</td></tr>').join('') + '</tbody></table></div>' +
          (rows[0].lates > rows[1].lates && rows[1].lates >= rows[2].lates && rows[0].lates >= 2 ? '<p class="sub" style="margin-top:6px">Lates are going up month by month.</p>' : '');
      } catch (e) { const el = box.querySelector('#ap-habits'); if (el) el.innerHTML = '<p class="sub">Could not load: ' + esc(e.message) + '</p>'; }
    }

    async function extras() {
      const el = () => box.querySelector('#ap-slips');
      const { data: slips, error } = await c.from('payslips').select('month, data').eq('email', emp.email).order('month', { ascending: false });
      let hist = [];
      try { const pp = await c.from('people').select('id').eq('email', emp.email).maybeSingle(); if (pp && pp.data) { const h = await c.from('salary_history').select('month, data').eq('person', pp.data.id).order('month', { ascending: false }); hist = h.data || []; } } catch (x) { hist = []; }
      if (!el()) return;
      if (error) { el().innerHTML = '<p class="sub">Could not load payslips.</p>'; return; }
      el().innerHTML = ((slips || []).length ? slips.map(s => '<details class="card" style="background:var(--surface);border-radius:14px;padding:10px 12px;margin:6px 0;box-shadow:var(--shadow)"><summary style="display:flex;justify-content:space-between;gap:10px;cursor:pointer;list-style:none"><b>' + esc(A().monthLabel(s.month)) + '</b><span>Paid days ' + esc(s.data.paidDays) + ' · <b>' + A().rs(s.data.net) + '</b></span></summary>' +
        '<div style="margin-top:6px;font-size:13px">' + (s.data.lines || []).map(([k, v]) => '<div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;border-bottom:1px dashed var(--sand)"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('') + '</div></details>').join('') : '<div class="empty">No locked months yet.</div>') +
        (hist.length ? '<div class="sechead" style="margin-top:14px"><h2>Before the app</h2></div>' + hist.map(h => { const x = h.data || {}; return '<div class="card" style="background:var(--surface);border-radius:14px;padding:10px 12px;margin:6px 0;box-shadow:var(--shadow);display:flex;justify-content:space-between;gap:10px"><span><b>' + esc(A().monthLabel(h.month)) + '</b><br><span class="sub" style="font-size:12px">' + esc([x.presents != null ? x.presents + ' present' : '', x.half_days ? x.half_days + ' half day' : '', x.leave ? x.leave + ' leave' : '', x.late ? x.late + ' late' : '', x.status || ''].filter(Boolean).join(' · ')) + '</span></span><b>' + (x.net != null ? A().rs(x.net) : '–') + '</b></div>'; }).join('') : '');
    }

    load();
    return { close };
  }

  window.MutosAttProfile = { open, summaryHtml, counts };
})();
