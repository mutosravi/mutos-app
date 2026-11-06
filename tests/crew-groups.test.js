// One person, several crew entries: same name = one page; different names with the same Gmail = one page too.
// Run: node tests/crew-groups.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const win = {}; vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'crew-sync.js'), 'utf8'), { window: win, setInterval() {}, setTimeout() {}, clearTimeout() {}, document: { addEventListener() {} }, console });
const g = win.MUTOS_APP.groupCrew, norm = s => String(s || '').trim().toLowerCase();
const recs = [
  { name: 'Ravi', role: 'Cine', email: 'ravi@x.com' }, { name: 'Ravi', role: 'Drone Pilot' },
  { name: 'Sachin J Team', email: 'sachin@x.com' }, { name: 'Sachin John', email: 'Sachin@x.com' },
  { name: 'Hamza', email: 'hamza@x.com' }, { name: 'Old', email: 'old@x.com', left: true }, { name: 'NoMail' }
];
const m = g(recs, norm);
ok(m.size === 3 && m.get('ravi').keys.join() === 'ravi', 'Ravi (Cine + Drone, same name) is one person with one board name');
ok(m.has('sachin j team') && !m.has('sachin john') && m.get('sachin j team').keys.join('|') === 'sachin j team|sachin john' && m.get('sachin j team').emails.size === 1, 'two names with the same Gmail are one page with both names');
ok(m.get('hamza').keys.length === 1 && !m.has('old') && !m.has('nomail'), 'people who left or have no Gmail get no page');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
