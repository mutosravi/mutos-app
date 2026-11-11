// Turn a Muto's backup file (Backups → Download) back into SQL that refills the studio's tables in a database.
// For a disaster: a new Supabase project → run supabase/schema.sql and every numbered file in order → run the SQL this makes
// in the SQL Editor. The shoot board itself is restored with "Load backup" on the board (it reads the same file).
// Usage: node tools/backup-to-sql.mjs mutos-backup-nightly-2026-11-12.json [photos.json] > restore.sql
// It REPLACES the studio's tables with the backup (a new project comes with starter rows, e.g. the people list, whose ids would
// not match), so run it only to rebuild after a loss. Running it twice gives the same result. The board (docs) is not touched.
import fs from 'fs';
import { STUDIO_TABLES } from '../worker/backup.js';

const [file, photosFile] = process.argv.slice(2);
if (!file) { console.error('Usage: node tools/backup-to-sql.mjs <backup.json> [photos.json] > restore.sql'); process.exit(1); }
const b = JSON.parse(fs.readFileSync(file, 'utf8'));
const photos = photosFile ? JSON.parse(fs.readFileSync(photosFile, 'utf8')) : {};
if (!b.studio) { console.error('This backup is from before 12 Nov 2026 and holds only the board: use Load backup on the board.'); process.exit(1); }
// put families' photos back if they were stored in the second file
(b.studio.client_itinerary || []).forEach(it => ((it.data && it.data.vip) || []).forEach(p => { if (p && typeof p.photo === 'string' && p.photo.startsWith('photos:')) p.photo = photos[p.photo.slice(7)] || null; }));

const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const out = ['-- Muto\'s restore from ' + (b.savedAt || file) + '. Run after schema.sql and all numbered supabase/*.sql files.',
  'begin;', "set local session_replication_role = replica;  -- copy the rows exactly as they were (no triggers re-stamping them)"];
const present = STUDIO_TABLES.map(([t]) => t).filter(t => Array.isArray(b.studio[t]));   // tables that could not be read are left alone
if (present.length) out.push('truncate table ' + present.map(t => 'public.' + t).join(', ') + ';');
// parents first (people before work jobs, drives before drive items, cards before card moves …)
for (const [t] of STUDIO_TABLES) {
  const rows = b.studio[t];
  if (!rows || !rows.length) continue;
  for (let i = 0; i < rows.length; i += 500) {
    out.push('insert into public.' + t + ' select * from jsonb_populate_recordset(null::public.' + t + ', ' + q(JSON.stringify(rows.slice(i, i + 500))) + '::jsonb);');
  }
}
// identity / serial counters continue after the restored ids
for (const [t, seqTable] of [['att_punch', 'att_punch'], ['att_log', 'att_log'], ['drive_log', 'drive_log'], ['card_log', 'card_log'], ['client_apply_log', 'client_apply_log']]) {
  if ((b.studio[t] || []).length) out.push("select setval(pg_get_serial_sequence('public." + seqTable + "', 'id'), (select coalesce(max(id), 1) from public." + seqTable + '));');
}
out.push('commit;');
const missing = Object.keys(b.studio_errors || {});
if (missing.length) out.unshift('-- NOTE: these tables could not be read when the backup was made, so they are not in it: ' + missing.join(', '));
process.stdout.write(out.join('\n') + '\n');
console.error('Restore SQL for ' + STUDIO_TABLES.filter(([t]) => (b.studio[t] || []).length).length + ' tables, ' + STUDIO_TABLES.reduce((n, [t]) => n + (b.studio[t] || []).length, 0) + ' rows.');
