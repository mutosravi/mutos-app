// Muto's app · salary calculator (same code on the employee page, the admin page and in tests).
// Rules decided by Ravi, 6 Nov 2026: 8 working hours a day (lunch excluded), 45-min lunch with check-out/in,
// 15-min grace, late up to 1 h 30 min (3 lates = ½ day cut; the late minutes are not cut again), half day after that, short days paid by hours,
// weekly off per person, paid leave only for some, holidays paid, working on a holiday when asked = holiday pay + day's pay,
// shoot day: Type A = paid office day (+ later start after an evening shoot), Type B = unpaid office day (office hours paid by the hour).
(function (root) {
  const pad = n => String(n).padStart(2, '0');
  const IST = 330; // minutes ahead of UTC
  // minutes after midnight, India time
  const istMin = iso => { const t = Date.parse(iso) / 60000 + IST; return ((t % 1440) + 1440) % 1440; };
  const hm = s => { const [h, m] = String(s || '0:0').split(':').map(Number); return h * 60 + (m || 0); };
  const fmtT = m => { m = Math.round(m); const h = Math.floor(m / 60) % 24; return ((h % 12) || 12) + ':' + pad(m % 60) + (h < 12 ? ' am' : ' pm'); };
  const fmtH = m => { m = Math.max(0, Math.round(m)); return Math.floor(m / 60) + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); };
  const addDay = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const dayName = d => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const monthDays = month => { const [y, m] = month.split('-').map(Number); const n = new Date(Date.UTC(y, m, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => month + '-' + pad(i + 1)); };
  const RULES = { hours: 8, lunch: 45, grace: 15, lateUpto: 90, latesPerHalf: 3 };

  // one office day from its check-ins: { hours, inMin, outMin, late, kind: ok|late|half|open|missing, pay }
  function officeDay(list, start, opts) {
    // an approved correction (by_fix) wins over what was tapped: e.g. a check-out tapped by mistake at 2 pm, corrected to 7 pm
    const at = k => { const p = list.filter(x => x.kind === k).sort((a, b) => a.at.localeCompare(b.at)); if (!p.length) return null; const fx = p.filter(x => x.by_fix); return istMin((fx.length ? fx[fx.length - 1] : k === 'out' ? p[p.length - 1] : p[0]).at); };
    const inM = at('in'), outM = at('out'), lo = at('lunch_out'), li = at('lunch_in');
    if (inM == null) return null;
    if (outM == null) return { inMin: inM, kind: opts.isToday ? 'open' : 'missing', hours: 0, pay: 0 };
    const lunch = lo != null && li != null ? Math.max(0, li - lo) : RULES.lunch;
    const worked = Math.max(0, outM - inM - lunch);
    const late = inM - start, endBy = start + RULES.hours * 60 + RULES.lunch, byHours = worked / (RULES.hours * 60);
    let kind = 'ok', pay;
    if (late <= RULES.grace) pay = Math.min(1, byHours);
    else if (late <= RULES.lateUpto) { kind = 'late'; pay = Math.min(1, (worked + late) / (RULES.hours * 60)); } // the late mark is the penalty for coming late; only leaving early or a long lunch is cut by hours
    else { kind = 'half'; pay = outM >= endBy ? 0.5 : Math.min(0.5, byHours); }
    return { inMin: inM, outMin: outM, late: Math.max(0, late), hours: worked / 60, worked, lunchAuto: lo == null, lunch, kind, pay };
  }

  function monthCalc(o) {
    const emp = o.emp, month = o.month, all = monthDays(month), upto = o.upto || all[all.length - 1], today = o.today || '';
    const settings = o.settings || {}, lateNight = settings.late_night_min == null ? 120 : settings.late_night_min;
    const typeA = emp.shoot_type === 'A';
    const shootOn = new Map(); (o.shoots || []).forEach(s => { if (!shootOn.has(s.date)) shootOn.set(s.date, []); shootOn.get(s.date).push(s); });
    const punchOn = new Map(); (o.punches || []).forEach(p => { if (!punchOn.has(p.day)) punchOn.set(p.day, []); punchOn.get(p.day).push(p); });
    const hol = d => (o.holidays || []).find(h => h.day === d && (!h.only_for || h.only_for.includes(emp.email)));
    const leaveOn = d => (o.leaves || []).find(l => l.status === 'approved' && l.day <= d && (l.day_to || l.day) >= d);
    const isOff = d => new Date(d + 'T00:00:00Z').getUTCDay() === Number(emp.weekly_off);
    const workingDays = all.filter(d => !isOff(d)).length;
    const daily = workingDays ? Number(emp.monthly_salary || 0) / workingDays : 0;
    let leaveLeft = Number(emp.paid_leave || 0), lates = 0;
    const days = [];
    all.forEach(d => {
      if (d > upto) return;
      const p = punchOn.get(d) || [], sh = shootOn.get(d), h = hol(d), lv = leaveOn(d);
      const prevEvening = (shootOn.get(addDay(d, -1)) || []).some(s => /evening|full/i.test(s.slot || ''));
      const start = hm(emp.start_time) + (typeA && prevEvening ? lateNight : 0);
      const od = officeDay(p, start, { isToday: d === today });
      const row = { date: d, day: dayName(d), pay: 0, status: '', note: '' };
      if (emp.joined && d < emp.joined) { row.status = 'before'; row.label = 'Before joining'; days.push(row); return; }
      const officePart = cap => od && od.kind !== 'open' && od.kind !== 'missing' ? Math.min(cap, od.worked / (RULES.hours * 60)) : 0;
      if (isOff(d)) { row.status = 'off'; row.label = 'Weekly off' + (sh ? ' · shoot' : '') + (h ? ' · ' + h.name : ''); }
      else if (h) {
        const base = h.half ? 0.5 : 1, asked = (h.ask_in || []).includes(emp.email);
        row.status = 'holiday'; row.label = (h.half ? 'Half-day holiday: ' : 'Holiday: ') + h.name; row.pay = base;
        if (od) {
          if (asked) { const extra = officePart(1); row.pay += extra; row.status = 'holiday_work'; row.note = 'Worked on holiday ' + fmtH(od.worked || 0) + ': +' + round2(extra) + ' day'; }
          else if (h.half) { row.pay += officePart(0.5); row.note = 'Worked the other half: ' + fmtH(od.worked || 0); }
          else row.note = 'Came in without being asked: not paid extra';
        }
      } else if (sh) {
        if (typeA) { row.status = 'shoot_paid'; row.pay = 1; row.label = 'On shoot (paid office day)'; }
        else { row.status = 'shoot'; row.pay = officePart(1); row.label = 'On shoot (unpaid office day)' + (row.pay ? ' · ' + fmtH(od.worked) + ' office' : ''); }
      } else if (lv) {
        const want = lv.half ? 0.5 : 1, paid = Math.min(want, leaveLeft); leaveLeft -= paid;
        row.status = paid ? 'leave_paid' : 'leave'; row.pay = paid; row.label = (lv.half ? 'Half-day ' : '') + (paid ? 'paid leave' : 'unpaid leave');
        if (lv.half && od) { row.pay += officePart(0.5); row.note = 'Worked ' + fmtH(od.worked || 0); }
      } else if (od) {
        row.inAt = fmtT(od.inMin); if (od.outMin != null) row.outAt = fmtT(od.outMin);
        if (od.kind === 'open') { row.status = 'open'; row.label = 'In office since ' + fmtT(od.inMin); }
        else if (od.kind === 'missing') { row.status = 'missing'; row.label = 'No check-out: ask to fix'; }
        else {
          row.pay = od.pay; row.hours = od.hours;
          row.status = od.kind === 'late' ? 'late' : od.kind === 'half' ? 'half' : od.pay < 1 ? 'short' : 'present';
          row.label = { present: 'Present', late: 'Late (' + Math.round(od.late) + ' min)', half: 'Half day (came ' + fmtT(od.inMin) + ')', short: 'Short day' }[row.status] + ' · ' + fmtH(od.worked);
          if (od.kind === 'late') lates++;
          if (od.lunchAuto) row.note = 'Lunch not marked: 45 min deducted';
          else if (od.lunch > RULES.lunch) row.note = 'Lunch ' + Math.round(od.lunch) + ' min';
          if (typeA && prevEvening) row.note = (row.note ? row.note + ' · ' : '') + 'Late start allowed after evening shoot';
        }
      } else if (d === today) { row.status = 'today'; row.label = 'Not checked in yet'; }
      else { row.status = 'absent'; row.label = 'Absent'; }
      if (od && od.inMin != null && !row.inAt) { row.inAt = fmtT(od.inMin); if (od.outMin != null) row.outAt = fmtT(od.outMin); }
      days.push(row);
    });
    const lateCut = Math.floor(lates / RULES.latesPerHalf) * 0.5;
    const paidDays = Math.max(0, days.reduce((s, r) => s + r.pay, 0) - lateCut);
    const gross = Math.round(daily * round2(paidDays)); // from the paid days shown on the payslip, so anyone can check it
    const recovery = [];
    (o.advances || []).filter(a => a.status === 'approved').forEach(a => {
      const left = Number(a.amount || 0) - Number(a.recovered || 0); if (left <= 0) return;
      const amt = Math.min(left, Number(a.per_month) > 0 ? Number(a.per_month) : left); recovery.push({ id: a.id, amount: Math.round(amt), left: Math.round(left - amt) });
    });
    const recTotal = recovery.reduce((s, r) => s + r.amount, 0);
    const count = st => days.filter(r => r.status === st).length;
    const lines = [];
    const mName = new Date(month + '-01T12:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    lines.push(['Working days in ' + mName + ' (weekly off excluded)', workingDays]);
    lines.push(['Day rate', inr(daily)]);
    if (count('before')) lines.push(['Days before joining (not paid)', count('before')]);
    const pd = (label, st) => { const n = count(st); if (n) lines.push([label, n]); };
    pd('Present (full days)', 'present'); pd('Late days', 'late'); pd('Half days', 'half'); pd('Short days (paid by hours)', 'short');
    pd('Paid leave', 'leave_paid'); pd('Unpaid leave', 'leave'); pd('Holidays (paid)', 'holiday'); pd('Worked on holiday (holiday + day)', 'holiday_work');
    pd('Shoot days, paid office days', 'shoot_paid'); pd('Shoot days, unpaid office days', 'shoot'); pd('Absent', 'absent'); pd('No check-out (not paid until fixed)', 'missing');
    if (lates) lines.push(['Late marks', lates + (lateCut ? ' → ' + lateCut + ' day cut' : ' (3 = ½ day cut)')]);
    lines.push(['Paid days', round2(paidDays)]);
    lines.push(['Salary for paid days', inr(gross)]);
    recovery.forEach(r => lines.push(['Advance recovery', '−' + inr(r.amount) + (r.left ? ' (' + inr(r.left) + ' left)' : ' (cleared)')]));
    return { email: emp.email, name: emp.name, month, upto, workingDays, daily, days, lates, lateCut, paidDays: round2(paidDays), gross, recovery, net: gross - recTotal, lines };
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function inr(n) { return '₹' + Math.round(n).toLocaleString('en-IN'); }
  const api = { monthCalc, monthDays, fmtT, fmtH, istMin, RULES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MutosPay = api;
})(typeof window !== 'undefined' ? window : globalThis);
