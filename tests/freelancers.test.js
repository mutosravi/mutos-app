// Free shooters in two groups: in-house and freelancers ("ask first"); ask freelancers on WhatsApp and note their answer
// (18 Nov 2026, Ravi: "Free Shooters should be of 2 categories, In house and freelancers. We need to ask freelancer if they are free or not").
// Run: node tests/freelancers.test.js <backup.json>
const path = require('path'), fs = require('fs'), http = require('http'); const { chromium } = require('playwright');
process.chdir(path.resolve(__dirname, '..'));
const ROOT = path.resolve('public'), OWNER = 'o@x.com', docs = new Map(), sleep = ms => new Promise(r => setTimeout(r, ms));
const bk = JSON.parse(fs.readFileSync(process.argv[2]));
[['events', bk.events], ['shooters', bk.shooters], ['gear', bk.equipment], ['assistants', bk.assistants || []], ['away', bk.unavailability || []], ['seasons', bk.seasons || []]].forEach(([c, l]) => l.forEach(e => docs.set(c + '/' + e.id, { collection: c, id: e.id, data: e })));
const members = new Map([[OWNER, { email: OWNER, role: 'owner' }]]);
function handle(d) { if (d.op === 'session') return { id: 'u1', email: OWNER, user_metadata: {} }; const t = d.table === 'docs' ? docs : d.table === 'members' ? members : new Map();
  const match = r => d.filters.every(([op, c, v]) => op === 'eq' ? r[c] === v : true);
  if (d.op === 'select') { let rows = [...t.values()].filter(match); if (d.range) rows = rows.slice(d.range[0], d.range[1] + 1); return { data: d.single ? rows[0] || null : rows, error: null }; }
  if (d.op === 'upsert') { d.rows.forEach(r => { if (d.table === 'docs') t.set(r.collection + '/' + r.id, r); }); return { data: null, error: null }; }
  if (d.op === 'delete' && d.table === 'docs') { [...t.values()].filter(match).forEach(r => t.delete(r.collection + '/' + r.id)); return { data: null, error: null }; }
  return { data: null, error: null }; }
const server = http.createServer((q, s) => { const p = q.url.split('?')[0], f = path.join(ROOT, p); if (!fs.existsSync(f)) { s.writeHead(404); s.end(); return; } s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html' }); s.end(fs.readFileSync(f)); });
(async () => {
  await new Promise(r => server.listen(8798, r));
  const b = await chromium.launch(), ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.exposeBinding('__mockCall', (src, d) => handle(d)); await ctx.addInitScript(fs.readFileSync('tests/mock-supabase.js', 'utf8')); await ctx.addInitScript(() => { try { sessionStorage.setItem('mutos-stay-old', '1'); } catch (e) {} });
  const p = await ctx.newPage(), errs = []; p.on('pageerror', e => errs.push(String(e)));
  let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
  await p.goto('http://localhost:8798/board.html#board'); await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });
  const set = await p.evaluate(() => {
    const A = window.__boardApi, st = A.state(), d0 = new Date(A.todayStr() + 'T12:00:00'); d0.setDate(d0.getDate() + 230); const day = d0.toISOString().slice(0, 10);
    const pool = st.shooters.filter(s => !s.left && !/team/i.test(s.role || '')), seen = new Set(), uniq = pool.filter(s => { const k = A.normalizeName(s.name); if (seen.has(k) || A.recordsForKey(k).length > 1) return false; seen.add(k); return true; });
    const [ih, f1, f2, f3] = uniq; ih.freelance = false; delete ih.ownKit; [f1, f2, f3].forEach(x => { x.freelance = true; }); f1.phone = '9999900001';
    const E = A.cleanEvent({ name: 'Freelance Test Sangeet', date: day, slot: 'Evening', coverage: '2+0', location: 'Lucknow' });
    st.events.push(E); A.save(); A.renderBoard();
    return { day, E: E.id, ih: ih.name, f1: f1.name, f2: f2.name, f3: f3.name, f1id: f1.id, f2id: f2.id };
  });
  const sec = '#sec-' + set.day;
  await p.evaluate(d => window.__boardApi.goToDate(d), set.day); await p.waitForSelector(sec + ' .sb-free-fl');
  const inT = await p.textContent(sec + ' .sb-free-in'), flT = await p.textContent(sec + ' .sb-free-fl');
  ok(/Free in-house/.test(inT) && inT.includes(set.ih) && !inT.includes(set.f1), 'the day shows "Free in-house" with ' + set.ih + ' and without the freelancers');
  ok(/Freelancers · ask first/.test(flT) && [set.f1, set.f2, set.f3].every(n => flT.includes(n)) && !flT.includes(set.ih), 'and "Freelancers · ask first" with ' + [set.f1, set.f2, set.f3].join(', '));
  // the ask window
  await p.click(sec + ' [data-action="askfree"]'); await p.waitForSelector('.af-row');
  const rowI = n => p.evaluate(n => [...document.querySelectorAll('.af-row')].findIndex(r => r.querySelector('.sb-modal-row-name').textContent.startsWith(n)), n);
  let i1 = await rowI(set.f1);
  const href = await p.getAttribute('.af-ask[data-i="' + i1 + '"]', 'href'), dhref = await p.getAttribute('.af-ask[data-i="' + i1 + '"]', 'data-wa');
  const waText = decodeURIComponent(dhref || '') + decodeURIComponent(href || '');
  ok(/9999900001/.test(waText) && /Are you free on/.test(waText) && /not free/.test(waText), 'Ask opens WhatsApp to ' + set.f1 + ' with "Are you free on … ? Please reply: morning / evening / full day / not free"');
  ok((await p.textContent('.af-row[data-i="' + i1 + '"]')).includes('not asked'), 'before asking: "not asked"');
  await p.evaluate(i => { const a = document.querySelector('.af-ask[data-i="' + i + '"]'); a.removeAttribute('href'); a.click(); }, i1); await sleep(400);
  i1 = await rowI(set.f1);
  ok((await p.textContent('.af-row[data-i="' + i1 + '"]')).includes('asked · no answer yet'), 'after Ask: "asked · no answer yet"');
  await p.click('.af-yes[data-i="' + i1 + '"]'); await sleep(300); i1 = await rowI(set.f1);
  ok((await p.textContent('.af-row[data-i="' + i1 + '"]')).includes('✓ said free'), set.f1 + ' said yes → "✓ said free"');
  const i2 = await rowI(set.f2); await p.click('.af-no[data-i="' + i2 + '"]'); await sleep(300);
  const st2 = await p.evaluate(s => { const st = window.__boardApi.state(); return { away: st.unavailability.some(u => u.personId === s.f2id && u.date === s.day && /Freelancer: not free/.test(u.reason)), avail: (st.shooters.find(x => x.id === s.f1id).avail || {})[s.day] }; }, set);
  ok(st2.away && (await rowI(set.f2)) === -1, set.f2 + ' said no → marked away that day ("Freelancer: not free") and off the list');
  ok(st2.avail === 'yes', 'the answer is kept on the person for that date');
  await p.click('#af-done'); await sleep(400);
  const flT2 = await p.textContent(sec + ' .sb-free-fl');
  ok(flT2.includes(set.f1 + ' ✓') && !flT2.includes(set.f2) && flT2.includes(set.f3), 'the day now shows ' + set.f1 + ' ✓, ' + set.f3 + ' still to ask, ' + set.f2 + ' gone (away)');
  // the crew picker says it too
  await p.click('#card-' + set.E + ' [data-action="crew"]'); await p.waitForSelector('.sb-modal-row');
  const sub = n => p.evaluate(n => { const r = [...document.querySelectorAll('.sb-modal-row')].find(x => x.querySelector('.sb-modal-row-name') && x.querySelector('.sb-modal-row-name').textContent.startsWith(n)); return r ? r.querySelector('.sb-modal-row-sub').textContent : ''; }, n);
  ok(/✓ freelancer, said free/.test(await sub(set.f1)) && /freelancer: ask first/.test(await sub(set.f3)) && !/freelancer/.test(await sub(set.ih)), 'crew picker: "✓ freelancer, said free", "freelancer: ask first", nothing for in-house');
  await p.keyboard.press('Escape'); await sleep(300);
  // day status message
  await p.click(sec + ' [data-action="daystatus"]'); await sleep(400);
  const ds = await p.evaluate(() => [...document.querySelectorAll('.sb-modal textarea, .sb-modal .sb-msg, .sb-modal pre')].map(x => x.value || x.textContent).join('\n'));
  ok(/Free in-house \(\d+\):/.test(ds) && new RegExp('Freelancers to ask \\(\\d+\\): .*' + set.f1 + ' \\(✓ free\\)').test(ds), 'the day status message lists in-house and freelancers to ask');
  await p.keyboard.press('Escape'); await sleep(300);
  // saved: kept by cleanPerson across a reload
  await p.reload(); await p.waitForFunction(() => window.__boardApi, null, { timeout: 20000 });
  const kept = await p.evaluate(s => { const x = window.__boardApi.state().shooters.find(y => y.id === s.f1id); return x.freelance === true && (x.avail || {})[s.day] === 'yes'; }, set);
  ok(kept, 'after a reload: still a freelancer, still "said free" for that day');
  ok(!errs.length, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close(); server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
