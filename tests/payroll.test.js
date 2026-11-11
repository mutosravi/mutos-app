// Salary rules (public/payroll.js). Run: node tests/payroll.test.js
const P = require('../public/payroll.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const near = (a, b) => Math.abs(a - b) < 0.01;
const at = (day, t) => new Date(day + 'T' + t + ':00+05:30').toISOString();
const punches = (day, ...pairs) => pairs.map(([kind, t]) => ({ day, kind, at: at(day, t) }));
const month = '2026-11', days = P.monthDays(month);
const wd = d => new Date(d + 'T00:00:00Z').getUTCDay();
const workdays = days.filter(d => wd(d) !== 0); // weekly off Sunday
const emp = { email: 'a@x.com', name: 'A', monthly_salary: 30000, start_time: '10:00', weekly_off: 0, paid_leave: 1, shoot_type: 'B' };
const [d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14] = workdays;
const day = (r, d) => r.days.find(x => x.date === d);

// ── office days ──
let p = [
  ...punches(d1, ['in', '09:58'], ['lunch_out', '13:00'], ['lunch_in', '13:40'], ['out', '19:00']),   // on time
  ...punches(d2, ['in', '10:30'], ['out', '18:50']),                                                 // late, stays till end
  ...punches(d3, ['in', '10:40'], ['out', '18:00']),                                                 // late and leaves early
  ...punches(d4, ['in', '12:00'], ['out', '19:00']),                                                 // after 1 h 30 → half day
  ...punches(d5, ['in', '10:00'], ['out', '15:00']),                                                 // leaves early, lunch not marked
  ...punches(d6, ['in', '10:20'], ['lunch_out', '13:00'], ['lunch_in', '14:30'], ['out', '18:50']),  // late #3, long lunch
  ...punches(d7, ['in', '10:00'])                                                                     // forgot to check out
];
let r = P.monthCalc({ emp, month, punches: p, upto: d7 });
ok(day(r, d1).status === 'present' && day(r, d1).pay === 1, 'on time, 8 h+ → full day');
ok(day(r, d2).status === 'late' && day(r, d2).pay === 1, 'late but stays till end time → full day + late mark');
ok(day(r, d3).status === 'late' && near(day(r, d3).pay, (7 * 60 + 20 - 45 + 40) / 480), 'late and leaves early → paid by hours, late minutes not cut twice (' + day(r, d3).pay.toFixed(3) + ')');
ok(day(r, d4).status === 'half' && day(r, d4).pay === 0.5, 'more than 1 h 30 late → half day');
ok(day(r, d5).status === 'short' && near(day(r, d5).pay, (5 * 60 - 45) / 480) && /45 min deducted/.test(day(r, d5).note), 'leaves early, lunch not marked → 45 min deducted, paid by hours');
ok(day(r, d6).status === 'late' && /Lunch 90 min/.test(day(r, d6).note) && near(day(r, d6).pay, (8 * 60 + 30 - 90 + 20) / 480), 'long lunch → extra minutes unpaid');
ok(day(r, d7).status === 'missing' && day(r, d7).pay === 0, 'no check-out → not paid until fixed');
ok(r.lates === 3 && r.lateCut === 0.5, '3 late marks → ½ day cut');
const expPaid = 1 + 1 + (7 * 60 + 20 - 45 + 40) / 480 + 0.5 + (5 * 60 - 45) / 480 + (8 * 60 + 30 - 90 + 20) / 480 - 0.5;
ok(near(r.paidDays, Math.round(expPaid * 100) / 100), 'paid days add up: ' + r.paidDays);
ok(r.workingDays === workdays.length && near(r.daily, 30000 / workdays.length), 'day rate = salary ÷ working days without weekly off (' + r.workingDays + ' days)');
ok(Math.abs(r.gross - r.daily * r.paidDays) <= 1, 'salary = day rate × paid days (₹' + r.gross + ')');

// ── holidays, leave, shoots, advances ──
const sundays = days.filter(d => wd(d) === 0);
r = P.monthCalc({
  emp: Object.assign({}, emp, { shoot_type: 'B' }), month,
  holidays: [{ day: d1, name: 'Diwali', ask_in: ['a@x.com'] }, { day: d2, name: 'Rain', ask_in: [] }, { day: sundays[1], name: 'On a Sunday' }, { day: d3, name: 'Only others', only_for: ['b@x.com'] }],
  punches: [...punches(d1, ['in', '10:00'], ['out', '18:45']), ...punches(d2, ['in', '10:00'], ['out', '18:45']), ...punches(d3, ['in', '10:00'], ['out', '18:45']), ...punches(d4, ['in', '10:00'], ['out', '13:45'])],
  shoots: [{ date: d4, slot: 'Evening' }, { date: d5, slot: 'Full day' }],
  leaves: [{ day: d6, day_to: d7, status: 'approved' }, { day: d8, status: 'declined' }],
  advances: [{ id: 'adv1', amount: 10000, per_month: 2500, recovered: 0, status: 'approved' }, { id: 'adv2', amount: 5000, per_month: 0, recovered: 5000, status: 'approved' }, { id: 'adv3', amount: 4000, status: 'pending' }]
});
ok(day(r, d1).status === 'holiday_work' && day(r, d1).pay === 2, 'asked to come in on a holiday → holiday pay + a day\'s pay');
ok(day(r, d2).status === 'holiday' && day(r, d2).pay === 1 && /without being asked/.test(day(r, d2).note), 'came in on a holiday without being asked → holiday pay only, flagged');
ok(day(r, sundays[1]).status === 'off', 'holiday on the weekly off → just the off day');
ok(day(r, d3).status === 'present', 'holiday for other people only → normal day');
ok(day(r, d4).status === 'shoot' && near(day(r, d4).pay, (3 * 60 + 45 - 45) / 480), 'Type B: office in the morning + shoot → office hours paid by the hour');
ok(day(r, d5).status === 'shoot' && day(r, d5).pay === 0, 'Type B: shoot day = unpaid office day');
ok(day(r, d6).status === 'leave_paid' && day(r, d6).pay === 1 && day(r, d7).status === 'leave' && day(r, d7).pay === 0, 'paid leave used up (1 a month), then unpaid leave');
ok(day(r, d8).status === 'absent', 'declined leave → absent');
ok(r.recovery.length === 1 && r.recovery[0].amount === 2500 && r.recovery[0].left === 7500 && r.net === r.gross - 2500, 'advance recovered ₹2,500 a month; cleared and pending advances ignored');

// ── Type A ──
r = P.monthCalc({
  emp: Object.assign({}, emp, { shoot_type: 'A' }), month, settings: { late_night_min: 120 },
  shoots: [{ date: d1, slot: 'Evening' }, { date: d3, slot: 'Morning' }],
  punches: [...punches(d2, ['in', '11:50'], ['out', '20:35']), ...punches(d4, ['in', '10:40'], ['out', '19:30'])]
});
ok(day(r, d1).status === 'shoot_paid' && day(r, d1).pay === 1, 'Type A: shoot day = paid office day');
ok(day(r, d2).status === 'present' && /Late start allowed/.test(day(r, d2).note), 'Type A: after an evening shoot, starting at 11:50 is not late');
ok(day(r, d4).status === 'late', 'Type A: after a morning shoot, normal start time');
const rb = P.monthCalc({ emp: Object.assign({}, emp, { shoot_type: 'B' }), month, shoots: [{ date: d1, slot: 'Evening' }], punches: punches(d2, ['in', '11:50'], ['out', '20:35']) });
ok(day(rb, d2).status === 'half', 'Type B: no late-night rule');

// ── joining date ──
r = P.monthCalc({ emp: Object.assign({}, emp, { joined: d5 }), month, punches: punches(d5, ['in', '10:00'], ['out', '18:45']) , upto: d5 });
ok(day(r, d4).status === 'before' && day(r, d4).pay === 0 && day(r, d5).status === 'present' && r.days.filter(x => x.status === 'absent').length === 0, 'days before joining are not counted as absent');
// ── so far / today ──
r = P.monthCalc({ emp, month, upto: d3, today: d3, punches: punches(d3, ['in', '09:55']) });
ok(r.days.length === days.indexOf(d3) + 1 && day(r, d3).status === 'open', 'this month so far stops at today; today shows "in office"');
// ── a check-out tapped by mistake, then corrected (Ravi, 11 Nov) ──
{
  const wrong = punches(d1, ['in', '10:00'], ['out', '14:00']);
  let x = P.monthCalc({ emp, month, punches: wrong, upto: d1 });
  ok(day(x, d1).pay < 1 && day(x, d1).outAt === '2:00 pm', 'mistaken check-out at 2 pm alone: a short day');
  const fixed = wrong.concat([{ day: d1, kind: 'out', at: at(d1, '19:00'), by_fix: true }]);
  x = P.monthCalc({ emp, month, punches: fixed, upto: d1 });
  ok(day(x, d1).status === 'present' && day(x, d1).pay === 1 && day(x, d1).outAt === '7:00 pm', 'after the approved correction to 7 pm: full day, out 7:00 pm');
  const fixIn = punches(d2, ['in', '11:45'], ['out', '19:00']).concat([{ day: d2, kind: 'in', at: at(d2, '10:00'), by_fix: true }]);
  x = P.monthCalc({ emp, month, punches: fixIn, upto: d2 });
  ok(day(x, d2).inAt === '10:00 am' && day(x, d2).pay === 1, 'a corrected check-in also wins over the tapped one');
}
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
