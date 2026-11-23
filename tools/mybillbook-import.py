# One-time move from myBillBook into the Sales desk (041). The output holds client names and money: it is given to Ravi
# only and never committed.
#   python3 tools/mybillbook-import.py <parties.csv> <sales-summary.csv> <out.sql> <daybook-1.csv> [<daybook-2.csv> ...]
# parties.csv       = myBillBook "Partywise Outstanding" (every party with its balance: + to collect, − to pay)
# sales-summary.csv = myBillBook "Sales Summary" (deliverables, payment terms, due date and link of each bill; optional extras)
# daybook-*.csv     = myBillBook "DayBook", in date ranges of under 600 rows each (every bill, payment, purchase, expense)
# What goes in: every party; every sales bill (cancelled ones as cancelled) with its real number and total as ONE line
# (myBillBook's reports have no line detail; the original link is in the notes); purchase bills; payments in / out with
# their numbers, each linked to that party's bills oldest first (a payment taken while making a bill goes to that bill);
# expenses with their category. All the money sits in one closed account "myBillBook (before the app)", so the real
# accounts start from the balance Ravi types. Each party's "balance brought in" makes its balance equal myBillBook's.
import csv, re, sys, uuid, json, math
from collections import defaultdict
pfile, sfile, out = sys.argv[1], sys.argv[2], sys.argv[3]
dfiles = sys.argv[4:]
def table(path, head):
    L = open(path, encoding='utf-8-sig').read().splitlines()
    i = [k for k, l in enumerate(L) if l.startswith(head)][0]
    return list(csv.DictReader(L[i:]))
q = lambda s: 'null' if s is None or s == '' else "'" + str(s).replace("'", "''") + "'"
f = lambda s: float(s or 0)
r0 = lambda x: math.floor(x + 0.5)
def dmy(s):
    m = re.fullmatch(r'(\d{2})/(\d{2})/(\d{4})', (s or '').strip()); return f'{m[3]}-{m[2]}-{m[1]}' if m else None
P = table(pfile, 'Name,'); S = {r['Invoice No'].strip(): r for r in table(sfile, 'Invoice No,')} if sfile != '-' else {}
D = []
for p in dfiles: D += table(p, 'Date,')
for i, r in enumerate(D): r['_i'] = i
VENDOR = {'traditional photographer', 'freelance', 'employee with shoots', 'assistant', 'rental provider', 'video editor'}
GST_STATE = {'09': 'Uttar Pradesh', '27': 'Maharashtra', '36': 'Telangana', '06': 'Haryana', '07': 'Delhi'}
parties, byname = [], defaultdict(list)
for r in P:
    bal = f(r['Bal.']); cat = r['Party Category'].strip(); gst = r['GST'].strip().upper()
    ok_gst = bool(re.fullmatch(r'[0-9]{2}[A-Z0-9]{13}', gst))
    p = dict(id=str(uuid.uuid4()), name=r['Name'].strip()[:120], phone=re.sub(r'\D', '', r['Mob No.'])[:20], gstin=gst if ok_gst else '',
             state=(r['State'].strip() or (GST_STATE.get(gst[:2]) if ok_gst else '') or '')[:40],
             address=', '.join(x for x in [r['Address'].strip(), r['Pincode'].strip()] if x)[:300],
             kind='vendor' if cat.lower() in VENDOR or bal < 0 else 'customer',
             notes=(('myBillBook category: ' + cat) if cat else '') + ('' if ok_gst or not gst else ' · GST as typed: ' + gst), bal=bal, calc=0.0)
    parties.append(p); byname[p['name'].lower()].append(p)
def party(name, hint=None):
    # several parties with the same name (different people in myBillBook): bills and payments of that name all go to the
    # one that has a balance (else the first), so they stay together; the others keep their balance as brought in
    c = byname.get(name.strip().lower(), [])
    if not c: return None
    return ([x for x in c if abs(x['bal']) > 0] or c)[0]
key = lambda r: (dmy(r['Date']) or '', r['_i'])
docs, txns, unclear = [], [], []
# sales bills (and the ones cancelled in myBillBook)
for r in sorted([r for r in D if r['Transaction Type'] in ('Sales Invoice', 'Sales Invoice - Cancelled')], key=key):
    no = r['Sr No.'].strip(); cancelled = r['Transaction Type'].endswith('Cancelled'); s = S.get(no, {})
    p = party(r['Name'])
    if len(byname.get(r['Name'].strip().lower(), [])) > 1: unclear.append(no)
    tot = 0 if cancelled else f(r['Total Amount']); kind = 'gst_invoice' if no.startswith('MF/G/') else 'invoice'
    line = {'name': 'As per myBillBook bill ' + no, 'qty': 1, 'rate': round(tot, 2), 'unit': 'SSN'}
    if kind == 'gst_invoice': line['gst'] = 0; line['desc'] = 'Total includes GST, as billed in myBillBook'
    if s.get('Deliverables', '').strip(): line['deliverables'] = s['Deliverables'].strip()[:600]
    d = dict(id=str(uuid.uuid4()), kind=kind, number=no, date=dmy(r['Date']), due=dmy(s.get('Due Date', '')), party=p['id'], lines=[line], total=r0(tot), left=r0(tot),
             pay=s.get('Payment Terms', '').strip()[:300], cancelled=cancelled,
             notes=('Moved from myBillBook on 23 Nov 2026.' + (' Original bill: ' + s['Invoice Link'].strip() if s.get('Invoice Link', '').strip() else ''))[:1000])
    docs.append(d)
    if not cancelled: p['calc'] += d['total']
    if f(r['Money In']) > 0 and not cancelled:   # paid while making the bill
        txns.append(dict(kind='in', number='with bill ' + no, date=d['date'], amount=f(r['Money In']), party=p, first=d['id'], why='Received with bill ' + no))
# purchase bills
for r in sorted([r for r in D if r['Transaction Type'] == 'Purchase Bill'], key=key):
    no = 'PUR-' + r['Sr No.'].strip(); p = party(r['Name'])
    tot = f(r['Total Amount'])
    d = dict(id=str(uuid.uuid4()), kind='purchase', number=no, date=dmy(r['Date']), due=None, party=p['id'], lines=[{'name': 'As per myBillBook purchase bill ' + r['Sr No.'].strip(), 'qty': 1, 'rate': round(tot, 2), 'unit': 'PCS'}],
             total=r0(tot), left=r0(tot), pay='', cancelled=False, notes='Moved from myBillBook on 23 Nov 2026.')
    docs.append(d); p['calc'] -= d['total']
    if f(r['Money Out']) > 0:
        txns.append(dict(kind='out', number='with purchase ' + r['Sr No.'].strip(), date=d['date'], amount=f(r['Money Out']), party=p, first=d['id'], why='Paid with purchase bill ' + r['Sr No.'].strip()))
for r in D:
    t = r['Transaction Type']
    if t == 'Payment-in': txns.append(dict(kind='in', number='IN-' + r['Sr No.'].strip(), date=dmy(r['Date']), amount=f(r['Money In']), party=party(r['Name']), first=None, why=''))
    elif t == 'Payment-out': txns.append(dict(kind='out', number='OUT-' + r['Sr No.'].strip(), date=dmy(r['Date']), amount=f(r['Money Out']), party=party(r['Name']), first=None, why=''))
    elif t == 'Expense': txns.append(dict(kind='expense', number='EXP-' + r['Sr No.'].strip(), date=dmy(r['Date']), amount=f(r['Money Out']), party=None, category=r['Name'].strip()[:60] or 'Other', first=None, why=''))
txns = [t for t in txns if t['amount'] > 0]
txns.sort(key=lambda t: (t['date'] or '', 0 if t['first'] else 1, t['number']))
# link each payment to that party's bills, oldest first (bills of the same party only)
bydoc = {d['id']: d for d in docs}
open_of = lambda pid, kinds: sorted([d for d in docs if d['party'] == pid and d['kind'] in kinds and not d['cancelled'] and d['left'] > 0], key=lambda d: (d['date'] or '', d['number']))
for t in txns:
    t['alloc'] = []
    if t['kind'] == 'expense' or not t['party']: continue
    p = t['party']; p['calc'] += -t['amount'] if t['kind'] == 'in' else t['amount']
    left = t['amount']; kinds = ('invoice', 'gst_invoice') if t['kind'] == 'in' else ('purchase',)
    queue = ([bydoc[t['first']]] if t['first'] else []) + open_of(p['id'], kinds)
    for d in queue:
        if left <= 0.004: break
        x = round(min(left, d['left']), 2)
        if x <= 0: continue
        t['alloc'].append({'doc': d['id'], 'amount': x}); d['left'] = round(d['left'] - x, 2); left = round(left - x, 2)
ACC = str(uuid.uuid4())
S_ = ['-- One-time move from myBillBook (23 Nov 2026): parties, every bill, purchase, payment and expense since March 2024.',
      '-- Run ONCE in the Supabase SQL editor after 041_sales.sql. It stops if it (or the earlier balance-only import) already ran.',
      'begin;',
      "do $$ begin if exists (select 1 from public.sales_log where what like 'Moved from myBillBook%') then raise exception 'The myBillBook move has already been run. Nothing was changed.'; end if; end $$;",
      f"insert into public.bank_accounts (id, name, kind, opening, opening_on, active, sort) values ('{ACC}', 'myBillBook (before the app)', 'bank', 0, '2024-03-01', false, 99);"]
for p in parties:
    S_.append(f"insert into public.parties (id, name, kind, phone, gstin, address, state, opening, notes, created_by) values ('{p['id']}', {q(p['name'])}, '{p['kind']}', {q(p['phone'])}, {q(p['gstin'])}, {q(p['address'])}, {q(p['state'])}, {round(p['bal'] - p['calc'], 2)}, {q(p['notes'].strip(' ·'))}, 'myBillBook import');")
for d in docs:
    S_.append(f"insert into public.sales_docs (id, kind, number, doc_date, due_date, party, lines, pay_terms, notes) values ('{d['id']}', '{d['kind']}', {q(d['number'])}, {q(d['date'])}, {q(d['due'])}, '{d['party']}', {q(json.dumps(d['lines'], ensure_ascii=False))}::jsonb, {q(d['pay'])}, {q(d['notes'])});")
for t in txns:
    S_.append(f"insert into public.money_txns (kind, number, txn_date, amount, account, party, category, mode, note, alloc) values ('{t['kind']}', {q(t['number'])}, {q(t['date'])}, {t['amount']}, '{ACC}', {q(t['party']['id']) if t['party'] else 'null'}, {q(t.get('category'))}, 'Other', {q(t['why'] or 'From myBillBook')}, {q(json.dumps(t['alloc']))}::jsonb);")
for d in docs:
    if d['cancelled']: S_.append(f"update public.sales_docs set status = 'cancelled', cancel_why = 'Cancelled in myBillBook' where id = '{d['id']}';")
mx = lambda k: max([int(re.sub(r'\D', '', x)) for x in [d['number'] for d in docs if d['kind'] == k] if re.sub(r'\D', '', x)] or [0])
S_ += ["update public.sales_series set next = greatest(next, 157) where kind = 'invoice';",
       "update public.sales_series set next = greatest(next, 21) where kind = 'gst_invoice';",
       f"update public.sales_series set next = greatest(next, {max([int(d['number'][4:]) for d in docs if d['kind'] == 'purchase' and d['number'][4:].isdigit()] or [0]) + 1}) where kind = 'purchase';",
       "insert into public.sales_log (what, by_email) values ('Moved from myBillBook (23 Nov 2026): parties, bills, purchases, payments and expenses since March 2024', 'myBillBook import');",
       'commit;',
       "-- check: should show 326 parties, to_collect 6245909.3 and to_pay 34825 (myBillBook's figures on 23 Nov 2026)",
       "select (select count(*) from public.parties) as parties, (select count(*) from public.sales_docs) as bills, (select count(*) from public.money_txns) as payments, sum(b) filter (where b > 0) as to_collect, -sum(b) filter (where b < 0) as to_pay from (select p.opening + coalesce((select sum(total) from public.sales_docs d where d.party = p.id and d.kind in ('invoice','gst_invoice') and d.status <> 'cancelled'), 0) - coalesce((select sum(total) from public.sales_docs d where d.party = p.id and d.kind = 'purchase' and d.status <> 'cancelled'), 0) - coalesce((select sum(amount) from public.money_txns m where m.party = p.id and m.kind = 'in' and m.status = 'ok'), 0) + coalesce((select sum(amount) from public.money_txns m where m.party = p.id and m.kind in ('out','expense') and m.status = 'ok'), 0) as b from public.parties p) x;"]
open(out, 'w').write('\n'.join(S_) + '\n')
print('parties', len(parties), 'docs', {k: sum(1 for d in docs if d['kind'] == k) for k in ('invoice', 'gst_invoice', 'purchase')}, 'cancelled', sum(d['cancelled'] for d in docs),
      'txns', {k: sum(1 for t in txns if t['kind'] == k) for k in ('in', 'out', 'expense')}, 'same-name bills', unclear,
      'party openings ≠ 0', [(p['name'], round(p['bal'] - p['calc'], 2)) for p in parties if abs(p['bal'] - p['calc']) > 0.5], file=sys.stderr)
