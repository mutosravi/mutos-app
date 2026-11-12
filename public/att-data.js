// Muto's app · attendance data shared by the employee page (work.html) and the admin page (attendance.html).
(function () {
  const pad = n => String(n).padStart(2, '0');
  const todayIST = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const monthOf = d => d.slice(0, 7);
  const lastDay = m => { const [y, mo] = m.split('-').map(Number); return m + '-' + pad(new Date(Date.UTC(y, mo, 0)).getUTCDate()); };
  const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1); };
  const monthLabel = m => new Date(m + '-01T12:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const t12 = t => { if (!t) return ''; const [h, m] = String(t).split(':').map(Number); return ((h % 12) || 12) + ':' + pad(m || 0) + (h < 12 ? ' am' : ' pm'); };
  const rs = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

  // everything needed to work out a month for some employees (RLS limits an employee to their own rows)
  async function loadMonth(c, month, emails) {
    const from = month + '-01', to = lastDay(month), prev = shiftMonth(month, -1) + '-28';
    const q = (t, f) => { let x = c.from(t).select('*'); if (f) x = f(x); return x; };
    const only = x => emails && emails.length === 1 ? x.eq('email', emails[0]) : x;
    const [pu, ho, rq, st] = await Promise.all([
      q('att_punch', x => only(x.gte('day', from).lte('day', to)).order('at', { ascending: true }).range(0, 9999)),
      q('holidays', x => x.gte('day', from).lte('day', to)),
      q('att_requests', x => only(x).order('created_at', { ascending: false })),
      q('att_settings', x => x.eq('id', 1).maybeSingle())
    ]);
    [pu, ho, rq].forEach(r => { if (r.error) throw r.error; });
    return { month, punches: pu.data || [], holidays: ho.data || [], requests: rq.data || [], settings: st.data || {}, prevFrom: prev };
  }
  // shoot days from the crew pages (person_key → [{date, slot}])
  async function loadShoots(c, keys) {
    const ks = (keys || []).filter(Boolean); if (!ks.length) return new Map();
    const { data, error } = await c.from('crew_feed').select('person_key, data').in('person_key', ks);
    if (error) return new Map();
    return new Map((data || []).map(r => [r.person_key, ((r.data && r.data.shoots) || []).map(s => ({ date: s.date, slot: s.slot }))]));
  }
  function calcFor(emp, d, shoots, opts) {
    const mine = x => x.email === emp.email;
    return window.MutosPay.monthCalc({
      emp, month: d.month, upto: opts && opts.upto, today: todayIST(), settings: d.settings,
      punches: d.punches.filter(mine), holidays: d.holidays, shoots: shoots || [],
      leaves: d.requests.filter(r => mine(r) && r.kind === 'leave'), advances: d.requests.filter(r => mine(r) && r.kind === 'advance')
    });
  }
  // location for check-in
  function locate() {
    return new Promise((ok, no) => {
      if (!navigator.geolocation) { no(new Error('This phone cannot share its location with the app.')); return; }
      navigator.geolocation.getCurrentPosition(p => ok({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        e => no(new Error(e.code === 1 ? 'Location is blocked for this app. Allow location in your phone settings, then try again.' : 'Could not get your location. Step near a window and try again.')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    });
  }
  const STATUS = {
    present: ['Present', '#dcebe6', '#1f4d43'], late: ['Late', '#f2dfa7', '#5c4410'], half: ['Half day', '#f0c9b8', '#6b2c1c'], short: ['Short day', '#efe4d6', '#2a1e22'],
    shoot: ['On shoot', '#e6d8ec', '#3d2a4a'], shoot_office: ['Office + shoot', '#d3e6df', '#2e3f5c'], shoot_paid: ['On shoot (paid)', '#e6d8ec', '#3d2a4a'], leave_paid: ['Paid leave', '#d9e6f2', '#1e3a5a'], leave: ['Unpaid leave', '#d9e6f2', '#1e3a5a'],
    holiday: ['Holiday', '#f4d9d0', '#5a2f3b'], holiday_work: ['Worked on holiday', '#9e4f62', '#ffffff'], off: ['Weekly off', '#ffffff', '#6f5f63'],
    absent: ['Absent', '#fbe2dc', '#7a2d1e'], before: ['Not joined', '#ffffff', '#b9aaae'], missing: ['No check-out', '#fbe2dc', '#7a2d1e'], open: ['In office', '#dcebe6', '#1f4d43'], today: ['Today', '#ffffff', '#2a1e22']
  };
  window.MutosAtt = { todayIST, monthOf, lastDay, shiftMonth, monthLabel, WEEK, t12, rs, loadMonth, loadShoots, calcFor, locate, STATUS };
})();
