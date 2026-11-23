# One-time import of myBillBook exports into the Sales desk (041). Output is given to Ravi only (client names stay out of GitHub).
import csv, re, sys, uuid, json
from collections import defaultdict
pfile, ifile, out = sys.argv[1], sys.argv[2], sys.argv[3]
def table(path, head):
    L = open(path, encoding='utf-8-sig').read().splitlines()
    i = [k for k, l in enumerate(L) if l.startswith(head)][0]
    return list(csv.DictReader(L[i:]))
P = table(pfile, 'Name,'); I = table(ifile, 'Invoice No,')
q = lambda s: 'null' if s is None or s == '' else "'" + str(s).replace("'", "''") + "'"
VENDOR = {'traditional photographer', 'freelance', 'employee with shoots', 'assistant', 'rental provider', 'video editor'}
GST_STATE = {'09': 'Uttar Pradesh', '27': 'Maharashtra', '36': 'Telangana', '06': 'Haryana', '07': 'Delhi'}
def dmy(s):
    m = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', (s or '').strip()); return f'{m[3]}-{m[2]}-{m[1]}' if m else None
parties = []
for r in P:
    bal = float(r['Bal.'] or 0); cat = r['Party Category'].strip(); gst = r['GST'].strip().upper()
    ok_gst = bool(re.fullmatch(r'[0-9]{2}[A-Z0-9]{13}', gst))
    state = r['State'].strip() or (GST_STATE.get(gst[:2]) if ok_gst else '') or ''
    addr = ', '.join(x for x in [r['Address'].strip(), r['Pincode'].strip()] if x)
    parties.append(dict(id=str(uuid.uuid4()), name=r['Name'].strip()[:120], phone=re.sub(r'\D', '', r['Mob No.'])[:20], gstin=gst if ok_gst else '', state=state[:40], address=addr[:300],
        kind='vendor' if cat.lower() in VENDOR or bal < 0 else 'customer', notes=('myBillBook category: ' + cat if cat else '') + ('' if ok_gst or not gst else ' · GST as typed: ' + gst), bal=bal, docs=0.0))
byname = defaultdict(list)
for p in parties: byname[p['name'].lower()].append(p)
docs, unsure = [], []
for r in I:
    rem, amt = float(r['Remaining Amount'] or 0), float(r['Amount'] or 0)
    if r['Invoice Status'] == 'Cancelled' or rem <= 0: continue
    c = byname[r['Contact Name'].strip().lower()]
    if len(c) > 1:
        withbal = [p for p in c if p['bal'] - p['docs'] >= rem - 0.5]
        if len(withbal) != 1: unsure.append(r['Invoice No']); c = (withbal or c)[:1]
        else: c = withbal
    import math
    p = c[0]; p['docs'] += math.floor(rem + 0.5)   # the app rounds a bill to the rupee; the paise stay in the opening balance
    no = r['Invoice No'].strip(); kind = 'gst_invoice' if no.startswith('MF/G/') else 'invoice'
    line = {'name': ('Balance of myBillBook bill ' if rem < amt else 'As per myBillBook bill ') + no, 'qty': 1, 'rate': round(rem, 2), 'unit': 'SSN',
            'desc': 'Bill total ₹{:,.0f}'.format(amt) + (' · received ₹{:,.0f} before moving to the app'.format(amt - rem) if rem < amt else '')}
    if kind == 'gst_invoice': line['gst'] = 0
    if r['Deliverables'].strip(): line['deliverables'] = r['Deliverables'].strip()[:600]
    docs.append(dict(kind=kind, number=no, date=dmy(r['Invoice Date']), due=dmy(r['Due Date']), party=p['id'], lines=[line], pay=r['Payment Terms'].strip()[:300],
        notes=('Moved from myBillBook on 23 Nov 2026. Original bill: ' + r['Invoice Link'].strip())[:1000]))
S = ['-- One-time import from myBillBook (23 Nov 2026). Run ONCE in the Supabase SQL editor, after 041_sales.sql.',
     '-- Parties with their balance, every unpaid / part-paid bill of the last 12 months (its balance due), next bill number. Safe to run twice (nothing is added twice).',
     'begin;']
for p in parties:
    S.append(f"insert into public.parties (id, name, kind, phone, gstin, address, state, opening, notes, created_by) select '{p['id']}', {q(p['name'])}, '{p['kind']}', {q(p['phone'])}, {q(p['gstin'])}, {q(p['address'])}, {q(p['state'])}, {round(p['bal'] - p['docs'], 2)}, {q(p['notes'].strip(' ·'))}, 'myBillBook import' where not exists (select 1 from public.sales_log where what = 'Moved from myBillBook (23 Nov 2026)');")
for d in docs:
    S.append(f"insert into public.sales_docs (kind, number, doc_date, due_date, party, lines, pay_terms, notes) select '{d['kind']}', {q(d['number'])}, {q(d['date'])}, {q(d['due'])}, '{d['party']}', {q(json.dumps(d['lines'], ensure_ascii=False))}::jsonb, {q(d['pay'])}, {q(d['notes'])} where exists (select 1 from public.parties where id = '{d['party']}') and not exists (select 1 from public.sales_docs where kind = '{d['kind']}' and number = {q(d['number'])});")
S += ["update public.sales_series set next = greatest(next, 157) where kind = 'invoice' and prefix = 'MF/SL/26-27/';",
      "update public.sales_series set next = 157 where kind = 'invoice' and prefix = 'MF/SL/26-27/' and next = 158 and not exists (select 1 from public.sales_docs where kind = 'invoice' and number = 'MF/SL/26-27/157');",
      "insert into public.sales_log (what, by_email) select 'Moved from myBillBook (23 Nov 2026)', 'myBillBook import' where not exists (select 1 from public.sales_log where what = 'Moved from myBillBook (23 Nov 2026)');",
      'commit;',
      "-- check: should show to_collect 6245909.3 and to_pay 34825 (myBillBook's figures on 23 Nov 2026)",
      "select count(*) as parties, sum(b) filter (where b > 0) as to_collect, -sum(b) filter (where b < 0) as to_pay from (select p.opening + coalesce((select sum(total) from public.sales_docs d where d.party = p.id and d.kind in ('invoice','gst_invoice') and d.status <> 'cancelled'), 0) as b from public.parties p) x;"]
open(out, 'w').write('\n'.join(S) + '\n')
print('parties', len(parties), 'bills', len(docs), 'due', round(sum(d['lines'][0]['rate'] for d in docs), 2), 'unsure', unsure, 'vendors', sum(p['kind'] == 'vendor' for p in parties), file=sys.stderr)
