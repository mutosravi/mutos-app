// Nightly backup of the whole team app into Cloudflare KV (a second company's storage, separate from Supabase).
// The file has the same shape as the board's "Save backup", so "Load backup" can restore it directly.
// Kept: the last 30 nightly copies, one per month for good, and the last 20 made by hand.
const KEEP_NIGHTLY = 30, KEEP_MANUAL = 20;
const pad = n => String(n).padStart(2, '0');
export function istNow(ms = Date.now()) { const d = new Date(ms + 5.5 * 3600e3); return { date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()), time: pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) }; }

function headersFor(env) { const k = env.SUPABASE_SECRET_KEY; return Object.assign({ apikey: k }, String(k).startsWith('eyJ') ? { Authorization: 'Bearer ' + k } : {}); }
async function allRows(env, fetchFn, table, select, order) {
  const base = String(env.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/' + table + '?select=' + select + '&order=' + order;
  const out = [];
  for (let off = 0; ; off += 1000) {
    const r = await fetchFn(base + '&limit=1000&offset=' + off, { headers: headersFor(env) });
    if (!r.ok) throw new Error(table + ': database ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const rows = await r.json(); out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

export async function makeBackup(env, fetchFn = fetch) {
  const docs = await allRows(env, fetchFn, 'docs', 'collection,id,data', 'collection,id');
  const of = c => docs.filter(d => d.collection === c).map(d => Object.assign({}, d.data, { id: d.id }));
  const history = docs.filter(d => d.collection === 'history').map(d => Object.assign({}, d.data, { id: d.id })).sort((a, b) => String(b.t).localeCompare(String(a.t))).slice(0, 500);
  const extra = async t => { try { return await allRows(env, fetchFn, t, '*', t === 'crew_status' ? 'person_key,event_id' : t === 'members' ? 'email' : t === 'gear_log' ? 'at' : 'id'); } catch (e) { return []; } };
  const [members, crewAway, crewStatus, gearLog] = await Promise.all([extra('members'), extra('crew_away'), extra('crew_status'), extra('gear_log')]);
  const b = {
    version: 3, savedAt: new Date().toISOString(), source: 'Mutos team app · automatic backup',
    shooters: of('shooters'), assistants: of('assistants'), equipment: of('gear'), events: of('events'), unavailability: of('away'), seasons: of('seasons'), settings: of('settings'),
    history, app: { members, crew_away: crewAway, crew_status: crewStatus, gear_log: gearLog }
  };
  return b;
}

export async function runBackup(env, kind = 'nightly', fetchFn = fetch) {
  if (!env.BACKUPS) throw new Error('Backup storage is not connected yet.');
  const b = await makeBackup(env, fetchFn), now = istNow(), json = JSON.stringify(b);
  const meta = { at: b.savedAt, shoots: b.events.length, people: b.shooters.length + b.assistants.length, gear: b.equipment.length, bytes: json.length };
  const name = kind === 'manual' ? 'manual/' + now.date + '-' + now.time : 'nightly/' + now.date;
  await env.BACKUPS.put(name, json, { metadata: meta });
  if (kind === 'nightly' && now.date.endsWith('-01')) await env.BACKUPS.put('monthly/' + now.date.slice(0, 7), json, { metadata: meta });
  // tidy up
  for (const [prefix, keep] of [['nightly/', KEEP_NIGHTLY], ['manual/', KEEP_MANUAL]]) {
    const names = (await listAll(env, prefix)).map(k => k.name).sort();
    for (const old of names.slice(0, Math.max(0, names.length - keep))) await env.BACKUPS.delete(old);
  }
  return { name, ...meta };
}

export async function listAll(env, prefix) {
  const out = []; let cursor;
  do { const r = await env.BACKUPS.list({ prefix, cursor }); out.push(...r.keys); cursor = r.list_complete ? null : r.cursor; } while (cursor);
  return out;
}
