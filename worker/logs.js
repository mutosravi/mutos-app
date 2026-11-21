// Daily Excel of cards and drives (21 Nov 2026, Ravi: "turn on daily excel sheet backup of data (cards and drives) with logs and
// original location of data"). Made every night after the backup (3 am India) and on demand from the Backups window:
//   · kept in this Worker's KV as logs/<date>.xlsx (last 60 days, one per month for good)
//   · and, once the studio's Google Drive is connected (Photos on Google Drive), saved there too: Muto's app photos /
//     Daily logs (Excel) / <YYYY-MM> / Muto's cards and drives <date>.xlsx
// Tabs: About · Where the data is (every folder on every drive, where it came from: which card and shoot, or which drive it was
// copied / moved from, its other copies, and where the drive is now) · Cards now (with where each card's footage is) · Card
// handovers · Card notes · Card copies · Card history · Drives now · Drive contents (also removed / moved lines) · Drive handovers ·
// Drive history · Gear log · Client history. Plain words: card codes, drive names, people's names, India time.
import { allRows, istNow, listAll } from './backup.js';
import { writeXlsx } from './xlsx.js';
import { auth, folderFor, putFile } from './photos.js';

const KEEP_DAYS = 60;
const T = ts => { if (!ts) return ''; const d = new Date(new Date(ts).getTime() + 5.5 * 3600e3); const p = n => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' + ((d.getUTCHours() % 12) || 12) + ':' + p(d.getUTCMinutes()) + (d.getUTCHours() < 12 ? ' am' : ' pm'); };
const DATA = { empty: 'Empty', hold: 'HOLD: not copied, do not format', single: 'Single copy (backup pending)', copied: 'Copied + backup' };
const WHAT = { raw: 'Raw', backup: 'Backup', project: 'Project', render: 'Render', final: 'Final', other: 'Other' };

export async function makeLogs(env, fetchFn = fetch) {
  const errors = [];
  const read = async (t, order) => { try { return await allRows(env, fetchFn, t, '*', order); } catch (e) { errors.push(t + ': ' + String(e.message || e).slice(0, 160)); return []; } };
  const [people, cards, cmoves, cuses, ccopies, clog, drives, items, dmoves, dlog, glog, hist] = await Promise.all([
    read('people', 'code'), read('cards', 'code'), read('card_moves', 'given_at.desc,id'), read('card_uses', 'at.desc,id'), read('card_copies', 'at.desc,id'), read('card_log', 'at.desc,id'),
    read('drives', 'name,id'), read('drive_items', 'added_at.desc,id'), read('drive_moves', 'given_at.desc,id'), read('drive_log', 'at.desc,id'), read('gear_log', 'at.desc,id'), read('client_log', 'at.desc,id')]);
  const P = new Map(people.map(p => [p.id, p.name])), K = new Map(cards.map(k => [k.id, k])), D = new Map(drives.map(d => [d.id, d])), I = new Map(items.map(i => [i.id, i]));
  const who = id => id ? (P.get(id) || 'someone') : 'Office';
  const dname = id => (D.get(id) || {}).name || '?';
  const where = d => !d ? '' : d.status === 'delivered' ? 'Given to the client' : d.status && d.status !== 'in_use' ? String(d.status).replace(/_/g, ' ') : d.holder ? 'With ' + who(d.holder) : 'In the office';
  const folderOf = i => i.path || '';
  const place = i => dname(i.drive) + (folderOf(i) ? ' › ' + folderOf(i).split('/').join(' › ') : '');
  // card copies and notes per line / card
  const copiesByLine = new Map(); ccopies.forEach(c => (c.items || []).forEach(id => { if (!copiesByLine.has(id)) copiesByLine.set(id, []); copiesByLine.get(id).push(c); }));
  const useOf = (card, cycle) => cuses.find(u => u.card === card && u.cycle === cycle && u.used) || null;
  const cardWords = c => { const k = K.get(c.card), u = useOf(c.card, c.cycle);
    return 'Card ' + (k ? k.code : '?') + (u ? ' (' + [u.shoot || u.wedding, u.media, u.style].filter(Boolean).join(', ') + ')' : '') + (c.backup ? ', backup copy' : ', first copy') + ' on ' + T(c.at) + ' by ' + (c.by_email || ''); };
  const cameFrom = i => {
    const cs = copiesByLine.get(i.id) || [];
    if (cs.length) return cs.map(cardWords).join(' · ');
    if (i.from_item) { const s = I.get(i.from_item); return (s && s.moved_to === i.id ? 'Moved from ' : 'Copied from ') + (s ? place(s) : 'another drive'); }
    return 'Typed in' + (i.added_by ? ' by ' + i.added_by : '');
  };
  const live = i => !i.removed_at;
  const otherCopies = i => items.filter(x => x.id !== i.id && live(x) && x.drive !== i.drive && (x.from_item === i.id || x.id === i.from_item || (i.from_item && x.from_item === i.from_item) ||
    String(x.title).trim().toLowerCase() === String(i.title).trim().toLowerCase())).map(place);

  const sheets = [];
  const add = (name, head, list, row) => sheets.push({ name, rows: [head].concat(list.map(row)) });
  const liveItems = items.filter(live).sort((a, b) => (dname(a.drive) + '/' + folderOf(a) + '/' + a.title).localeCompare(dname(b.drive) + '/' + folderOf(b) + '/' + b.title, 'en', { numeric: true }));
  add('Where the data is', ['Client', 'Data', 'Kind', 'Drive', 'Folder', 'Full location', 'Drive is now', 'Files', 'Size', 'Came from (original location)', 'Other copies', 'Backup', 'Added at', 'Added by'], liveItems, i => {
    const oc = otherCopies(i);
    return [i.wedding_key ? String(i.wedding_key).replace(/^[wpn]:/, '') : '', i.title, WHAT[i.what] || i.what, dname(i.drive), folderOf(i), place(i), where(D.get(i.drive)), i.files == null ? '' : Number(i.files), i.size_label || '',
      cameFrom(i), oc.join(' · '), i.no_backup ? 'No backup needed' + (i.no_backup_why ? ' (' + i.no_backup_why + ')' : '') : oc.length ? 'Yes (' + oc.length + ')' : (i.what === 'raw' ? 'NO BACKUP' : ''), T(i.added_at), i.added_by || ''];
  });
  add('Cards now', ['Card', 'Type', 'Size', 'Brand', 'Serial', 'With', 'Footage', 'Footage is on', 'Condition', 'Errors', 'Round', 'Notes'], cards, k => {
    const on = ccopies.filter(c => c.card === k.id && c.cycle === k.cycle).map(c => (c.drive_name || dname(c.drive)) + (c.folder ? ' › ' + String(c.folder).split('/').join(' › ') : '') + (c.backup ? ' (backup)' : ''));
    return [k.code, k.kind || '', k.size_label || '', k.brand || '', k.serial || '', who(k.holder), DATA[k.data] || k.data, k.data === 'empty' ? '' : on.join(' · '), k.condition, k.errors == null ? '' : Number(k.errors), k.cycle == null ? '' : Number(k.cycle), k.notes || ''];
  });
  add('Card handovers', ['Given at', 'Card', 'From', 'To', 'Given by', 'Status', 'Answered by', 'Answered at', 'Note'], cmoves, m => [T(m.given_at), (K.get(m.card) || {}).code || '?', who(m.from_person), who(m.to_person), m.given_by || '', m.status, m.answered_by || '', T(m.answered_at), m.note || '']);
  add('Card notes (shoots)', ['At', 'Card', 'Round', 'Used', 'Shoot', 'Wedding', 'Photo/video', 'Style', 'Camera', 'Note', 'By'], cuses, u => [T(u.at), (K.get(u.card) || {}).code || '?', u.cycle == null ? '' : Number(u.cycle), u.used ? 'yes' : 'not used', u.shoot || '', u.wedding || '', u.media || '', u.style || '', u.camera || '', u.note || '', u.by_email || '']);
  add('Card copies', ['At', 'Card', 'Round', 'Copy', 'Drive', 'Folder', 'Files', 'Size', 'By'], ccopies, x => [T(x.at), (K.get(x.card) || {}).code || '?', x.cycle == null ? '' : Number(x.cycle), x.backup ? 'Backup' : 'First copy', x.drive_name || dname(x.drive), x.folder || '', x.files == null ? '' : Number(x.files), x.size_label || '', x.by_email || '']);
  add('Card history', ['At', 'Card', 'What', 'By'], clog, l => [T(l.at), (K.get(l.card) || {}).code || '?', l.what, l.by_email || '']);
  add('Drives now', ['Drive', 'Type', 'Size', 'Model', 'Owner', 'Status', 'Where now', 'Free', 'Cleaned on', 'Folders on it', 'Notes'], drives, d => [d.name, d.kind || '', d.size_label || '', d.model || '', d.owner_type === 'client' ? 'Client: ' + (d.client_name || '') : 'Studio', d.status, where(d), d.free_label || '', d.cleaned_on || '', items.filter(i => i.drive === d.id && live(i)).length, d.notes || '']);
  add('Drive contents (all)', ['Drive', 'Folder', 'Data', 'Kind', 'Client', 'Files', 'Size', 'Came from', 'Note', 'Added at', 'Added by', 'Removed at', 'Why removed', 'Moved to'], items, i => [dname(i.drive), folderOf(i), i.title, WHAT[i.what] || i.what, i.wedding_key || '', i.files == null ? '' : Number(i.files), i.size_label || '', cameFrom(i), i.note || '', T(i.added_at), i.added_by || '', T(i.removed_at), i.removed_why || '', i.moved_to && I.get(i.moved_to) ? place(I.get(i.moved_to)) : '']);
  add('Drive handovers', ['Given at', 'Drive', 'From', 'To', 'Given by', 'Status', 'Answered by', 'Answered at', 'Note'], dmoves, m => [T(m.given_at), dname(m.drive), who(m.from_person), who(m.to_person), m.given_by || '', m.status, m.answered_by || '', T(m.answered_at), m.note || '']);
  add('Drive history', ['At', 'Drive', 'What', 'By'], dlog, l => [T(l.at), dname(l.drive), l.what, l.by_email || '']);
  add('Gear log', ['At', 'Gear', 'Out/In', 'Qty', 'Person', 'Shoot date', 'Condition', 'Note', 'Entered by'], glog, g => [T(g.at), g.gear_name, g.action === 'out' ? 'Out' : 'In', Number(g.qty) || 1, g.person_name, g.shoot_date || '', g.condition, g.note || '', g.by_email || '']);
  add('Client history', ['At', 'Wedding', 'Shoot', 'Card', 'What', 'By'], hist, h => [T(h.at), h.wedding || '', h.shoot || '', (K.get(h.card) || {}).code || '', h.what, h.by_email || '']);
  const noBackup = liveItems.filter(i => i.what === 'raw' && !i.no_backup && !otherCopies(i).length).length, onHold = cards.filter(k => k.data === 'hold').length;
  sheets.unshift({ name: 'About', rows: [['Muto\'s · cards and drives', ''], ['Made at', T(new Date().toISOString())],
    ['Cards', cards.length], ['Cards on hold (not copied)', onHold], ['Drives', drives.length], ['Folders on drives now', liveItems.length], ['Raw folders with no backup', noBackup],
    ['How to read', '"Where the data is" lists every folder on every drive: where it came from (card and shoot, or the drive it was copied / moved from), its other copies and where the drive is now. "Office" = in the office. Log tabs: newest first.']]
    .concat(errors.map(e => ['Could not read', e])) });
  return { bytes: writeXlsx(sheets), meta: { at: new Date().toISOString(), cards: cards.length, drives: drives.length, folders: liveItems.length, noBackup, onHold, errors: errors.length } };
}

// make today's file, keep it in KV and (if connected) put it on the studio's Google Drive
export async function runDailyLogs(env, fetchFn = fetch) {
  if (!env.BACKUPS) throw new Error('Backup storage is not connected yet.');
  const { bytes, meta } = await makeLogs(env, fetchFn), now = istNow(), name = 'logs/' + now.date;
  meta.bytes = bytes.byteLength;
  meta.drive = '';
  try {
    if (await auth(env)) {
      const folder = await folderFor(env, fetchFn, ['Daily logs (Excel)', now.date.slice(0, 7)]);
      const f = await putFile(env, fetchFn, { name: 'Muto\'s cards and drives ' + now.date + '.xlsx', parents: [folder] }, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes);
      meta.drive = f.id || 'saved';
    }
  } catch (e) { meta.driveError = String(e.message || e).slice(0, 200); }
  await env.BACKUPS.put(name, bytes, { metadata: meta });
  if (now.date.endsWith('-01')) await env.BACKUPS.put('logs-monthly/' + now.date.slice(0, 7), bytes, { metadata: meta });
  const names = (await listAll(env, 'logs/')).map(k => k.name).sort();
  for (const old of names.slice(0, Math.max(0, names.length - KEEP_DAYS))) await env.BACKUPS.delete(old);
  return { name, ...meta };
}
