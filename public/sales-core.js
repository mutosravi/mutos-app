// Sales desk helpers shared by sales.html (the desk) and bill.html (the share link). 041_sales.sql does the same sums on the
// server: a line = qty × rate, less disc % ; GST only on a GST invoice (or a purchase line with GST), CGST + SGST in the home
// state, IGST outside; the total is rounded to the rupee.
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const inr = (n, dec) => { const v = Number(n) || 0; return (v < 0 ? '−₹' : '₹') + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: dec ? 2 : 0, maximumFractionDigits: 2 }); };
  const KIND = { quotation: 'Quotation', invoice: 'Bill', gst_invoice: 'GST invoice', purchase: 'Purchase' };
  const TITLE = { quotation: 'QUOTATION / ESTIMATE', invoice: 'BILL OF SUPPLY', gst_invoice: 'TAX INVOICE', purchase: 'PURCHASE' };
  const TXN = { in: 'Payment in', out: 'Payment out', expense: 'Expense', transfer: 'Transfer' };

  function lineCalc(l, kind) {
    const q = l.qty === '' || l.qty == null ? 1 : Number(l.qty), r = Number(l.rate) || 0, d = Math.min(Math.max(Number(l.disc) || 0, 0), 100);
    const g = kind === 'gst_invoice' || (kind === 'purchase' && Number(l.gst) > 0) ? (l.gst === '' || l.gst == null ? 18 : Number(l.gst)) : 0;
    const amt = q * r, disc = amt * d / 100, taxable = amt - disc;
    return { qty: q, amt, disc, taxable, gst: g, tax: taxable * g / 100, total: taxable + taxable * g / 100 };
  }
  // same as sales_docs_rules(): sameState = the place of supply is the business's own state
  function calc(lines, kind, sameState) {
    let sub = 0, dis = 0, txb = 0, tx = 0;
    (lines || []).forEach(l => { const c = lineCalc(l, kind); sub += c.amt; dis += c.disc; txb += c.taxable; tx += c.tax; });
    const t = { subtotal: r2(sub), discount: r2(dis), taxable: r2(txb), cgst: 0, sgst: 0, igst: 0 };
    if (tx > 0 && sameState === false) t.igst = r2(tx); else { t.cgst = r2(tx / 2); t.sgst = r2(tx / 2); }
    t.total = Math.round(txb + tx); t.round_off = r2(t.total - (t.taxable + t.cgst + t.sgst + t.igst));
    return t;
  }
  // ₹ in words, Indian style: "Two Lakh Forty Eight Thousand Rupees Only"
  function words(n) {
    n = Math.round(Number(n) || 0); if (!n) return 'Zero Rupees Only';
    const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const two = x => x < 20 ? a[x] : b[Math.floor(x / 10)] + (x % 10 ? ' ' + a[x % 10] : '');
    const three = x => (x >= 100 ? a[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
    const parts = []; const cr = Math.floor(n / 1e7), lk = Math.floor(n / 1e5) % 100, th = Math.floor(n / 1e3) % 100, rest = n % 1000;
    if (cr) parts.push(three(cr) + ' Crore'); if (lk) parts.push(two(lk) + ' Lakh'); if (th) parts.push(two(th) + ' Thousand'); if (rest) parts.push(three(rest));
    return (n < 0 ? 'Minus ' : '') + parts.join(' ') + ' Rupees Only';
  }
  const day = d => { if (!d) return ''; const x = new Date(d + 'T00:00:00'); return isNaN(x) ? String(d) : x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };

  const CSS = '.mdoc{background:#fff;color:#2a1e22;max-width:820px;margin:0 auto;border-radius:6px;overflow:hidden;font:13px/1.45 "Open Sans",system-ui,sans-serif;box-shadow:0 4px 24px rgba(42,30,34,.12)}' +
    '.mdoc .mh{background:#F1E7CF;padding:22px 26px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;border-bottom:3px solid #CD9D23}' +
    '.mdoc .mh h1{margin:0;font-size:22px;letter-spacing:.02em}.mdoc .mh .co{font-size:12px;color:#5a4a4e;max-width:360px}.mdoc .mh .ttl{text-align:right}' +
    '.mdoc .mh .ttl b{display:block;font-size:15px;letter-spacing:.12em;color:#8a6510}.mdoc .mh .ttl span{display:block;font-size:12px;color:#5a4a4e}' +
    '.mdoc .mb{padding:18px 26px}.mdoc .to{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}.mdoc .to small{display:block;color:#8a7a7e;text-transform:uppercase;font-size:10.5px;letter-spacing:.08em}' +
    '.mdoc table{width:100%;border-collapse:collapse}.mdoc th{background:#CD9D23;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.05em;text-align:left;padding:7px 8px}' +
    '.mdoc td{padding:8px;border-bottom:1px solid #efe6d6;vertical-align:top}.mdoc td.n,.mdoc th.n{text-align:right;white-space:nowrap}' +
    '.mdoc .ev{font-size:11.5px;color:#8a6510;margin-top:2px}.mdoc .sm{font-size:11.5px;color:#6f5f63;margin-top:2px;white-space:pre-line}' +
    '.mdoc .tot{margin-left:auto;max-width:320px;margin-top:10px}.mdoc .tot div{display:flex;justify-content:space-between;padding:3px 0}.mdoc .tot .big{border-top:2px solid #CD9D23;margin-top:4px;padding-top:6px;font-weight:800;font-size:15px}' +
    '.mdoc .words{font-size:12px;color:#5a4a4e;margin-top:6px;text-align:right}.mdoc h4{margin:16px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#8a6510}' +
    '.mdoc .terms{white-space:pre-line;font-size:11px;color:#5a4a4e}.mdoc .sign{text-align:right;margin-top:26px;font-size:12px}.mdoc .stamp{display:inline-block;border:2px solid #b23b3b;color:#b23b3b;border-radius:6px;padding:2px 10px;font-weight:800;letter-spacing:.1em;transform:rotate(-4deg)}' +
    '.mdoc .mob{display:none;font-size:12px;font-weight:600;margin-top:2px}' +
    '@media (max-width:600px){.mdoc .dsk{display:none}.mdoc .mob{display:block}.mdoc .mh,.mdoc .mb{padding:14px}.mdoc td,.mdoc th{padding:7px 5px}.mdoc .mh .ttl{text-align:left}}' +
    '@media print{.mdoc .dsk{display:table-cell!important}.mdoc .mob{display:none!important}}' +
    '@media print{body{background:#fff!important}.mdoc{box-shadow:none;max-width:none}.noprint{display:none!important}}';

  // the printable bill (d = a sales_docs row or sales_doc_view(); party = { name, phone, gstin, address, state }; co = settings)
  function docHtml(d, party, co, banks) {
    co = co || {}; party = party || {}; const gst = d.kind === 'gst_invoice';
    const lines = d.lines || [];
    const rows = lines.map((l, i) => {
      const c = lineCalc(l, d.kind);
      const ev = [l.event, l.date ? day(l.date) : '', l.place, l.hours ? l.hours + ' hrs' : ''].filter(Boolean).join(' · ');
      return '<tr><td>' + (i + 1) + '</td><td><b>' + esc(l.name) + '</b>' + (ev ? '<div class="ev">' + esc(ev) + '</div>' : '') +
        '<div class="mob">' + c.qty + (l.unit ? ' ' + esc(l.unit) : '') + ' × ' + inr(l.rate) + (Number(l.disc) ? ' · ' + Number(l.disc) + '% off' : '') + (gst ? ' · GST ' + c.gst + '%' : '') + '</div>' +
        (l.desc ? '<div class="sm">' + esc(l.desc) + '</div>' : '') + (l.deliverables ? '<div class="sm"><b>Deliverables:</b> ' + esc(l.deliverables) + '</div>' : '') + '</td>' +
        '<td class="n dsk">' + c.qty + (l.unit ? ' ' + esc(l.unit) : '') + '</td><td class="n dsk">' + inr(l.rate) + '</td><td class="n dsk">' + (Number(l.disc) ? Number(l.disc) + '%' : '') + '</td>' +
        (gst ? '<td class="n dsk">' + c.gst + '%</td>' : '') + '<td class="n">' + inr(c.taxable + c.tax, true) + '</td></tr>';
    }).join('');
    const row = (k, v, cls) => '<div' + (cls ? ' class="' + cls + '"' : '') + '><span>' + k + '</span><span>' + v + '</span></div>';
    const bal = r2(d.total - (d.paid || 0));
    return '<div class="mdoc"><div class="mh"><div><h1>' + esc(co.name || "Muto's Films") + '</h1><div class="co">' + esc(co.address || '') +
      (co.phone ? '<br>' + esc(co.phone) : '') + (co.email ? ' · ' + esc(co.email) : '') + (co.website ? '<br>' + esc(co.website) : '') + (co.udyam ? ' · UDYAM ' + esc(co.udyam) : '') +
      (gst && co.gstin ? '<br><b>GSTIN ' + esc(co.gstin) + '</b>' : '') + '</div></div>' +
      '<div class="ttl"><b>' + TITLE[d.kind] + '</b><span>No. ' + esc(d.number) + '</span><span>Date ' + day(d.doc_date) + '</span>' +
      (d.due_date ? '<span>' + (d.kind === 'quotation' ? 'Valid till ' : 'Due ') + day(d.due_date) + '</span>' : '') + (d.status === 'cancelled' ? '<span class="stamp">CANCELLED</span>' : '') + '</div></div>' +
      '<div class="mb"><div class="to"><div><small>' + (d.kind === 'purchase' ? 'From' : 'Bill to') + '</small><b>' + esc(party.name) + '</b>' + (party.address ? '<br>' + esc(party.address) : '') +
      (party.phone ? '<br>' + esc(party.phone) : '') + (party.gstin ? '<br>GSTIN ' + esc(party.gstin) : '') + '</div>' +
      (gst ? '<div style="text-align:right"><small>Place of supply</small>' + esc(d.supply_state || '') + '</div>' : '') + (d.title ? '<div><small>For</small>' + esc(d.title) + '</div>' : '') + '</div>' +
      '<table><thead><tr><th>#</th><th>Service</th><th class="n dsk">Qty</th><th class="n dsk">Rate</th><th class="n dsk">Disc</th>' + (gst ? '<th class="n dsk">GST</th>' : '') + '<th class="n">Amount</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="tot">' + row('Sub total', inr(d.subtotal, true)) + (Number(d.discount) ? row('Discount', '− ' + inr(d.discount, true)) : '') +
      (gst ? row('Taxable value', inr(d.taxable, true)) + (Number(d.igst) ? row('IGST', inr(d.igst, true)) : row('CGST', inr(d.cgst, true)) + row('SGST', inr(d.sgst, true))) : '') +
      (Number(d.round_off) ? row('Round off', inr(d.round_off, true)) : '') + row('Total', inr(d.total), 'big') +
      (d.kind !== 'quotation' && Number(d.paid) ? row('Received', inr(d.paid)) + row('Balance', inr(bal), 'big') : '') + '</div>' +
      '<div class="words">' + words(d.total) + '</div>' +
      (d.pay_terms ? '<h4>Payment terms</h4><div>' + esc(d.pay_terms) + '</div>' : '') +
      ((banks || []).length && d.kind !== 'purchase' ? '<h4>Pay to</h4><div>' + banks.map(b => esc([b.bank || b.name, b.acc_no ? 'A/c ' + b.acc_no : '', b.ifsc ? 'IFSC ' + b.ifsc : '', b.upi ? 'UPI ' + b.upi : ''].filter(Boolean).join(' · '))).join('<br>') + '</div>' : '') +
      (d.notes ? '<h4>Notes</h4><div class="terms">' + esc(d.notes) + '</div>' : '') +
      (d.terms ? '<h4>Terms &amp; conditions</h4><div class="terms">' + esc(d.terms) + '</div>' : '') +
      '<div class="sign">For <b>' + esc(co.name || "Muto's Films") + '</b><br><br><span style="color:#8a7a7e">Authorised signatory</span></div></div></div>';
  }
  window.MutosSales = { esc, r2, inr, KIND, TITLE, TXN, lineCalc, calc, words, day, CSS, docHtml };
})();
