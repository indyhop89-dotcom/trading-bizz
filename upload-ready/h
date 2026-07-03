warning: in the working copy of 'src/pages/PI/index.jsx', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/pages/PO/index.jsx', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'src/utils/dates.js', LF will be replaced by CRLF the next time Git touches it
[1mdiff --git a/src/pages/PI/index.jsx b/src/pages/PI/index.jsx[m
[1mindex 812bc9c..a315018 100644[m
[1m--- a/src/pages/PI/index.jsx[m
[1m+++ b/src/pages/PI/index.jsx[m
[36m@@ -7,7 +7,7 @@[m [mimport {[m
 } from '../../components/UI/index'[m
 import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'[m
 import { formatINR, toNum } from '../../utils/money'[m
[31m-import { fmtDate, today, currentFYLabel } from '../../utils/dates'[m
[32m+[m[32mimport { fmtDate, today, currentFYLabel, parseFlexibleDate } from '../../utils/dates'[m
 import { buildHSNMap, resolveGSTRate } from '../../utils/hsn'[m
 import DocumentAttachments from '../../components/DocumentAttachments'[m
 import { calcSellRate } from '../../utils/margin'[m
[36m@@ -215,6 +215,23 @@[m [mfunction PIList() {[m
       if (!fromE) { errors.push(`Row group ${meta.from_entity}: entity not found`); continue }[m
       if (!toE)   { errors.push(`Row group ${meta.to_entity}: entity not found`);   continue }[m
 [m
[32m+[m[32m      // CHANGED: accept YYYY-MM-DD or DD-MM-YYYY from the CSV, normalize to ISO.[m
[32m+[m[32m      // Raw DD-MM-YYYY strings sent straight to Postgres fail with[m
[32m+[m[32m      // "date/time field value out of range" once the day exceeds 12.[m
[32m+[m[32m      const piDate = parseFlexibleDate(meta.pi_date)[m
[32m+[m[32m      if (!piDate) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}: pi_date "${meta.pi_date}" is not a valid date — use YYYY-MM-DD or DD-MM-YYYY`); continue }[m
[32m+[m[32m      const validUpto = meta.valid_upto ? parseFlexibleDate(meta.valid_upto) : null[m
[32m+[m[32m      if (meta.valid_upto && !validUpto) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}: valid_upto "${meta.valid_upto}" is not a valid date`); continue }[m
[32m+[m
[32m+[m[32m      // CHANGED: pi_no and financial_year_id are NOT NULL columns with no DB[m
[32m+[m[32m      // default — they were previously omitted here, so every CSV-created PI[m
[32m+[m[32m      // would have failed on that constraint right after the date fix. This[m
[32m+[m[32m      // mirrors the single-PI create flow: resolve FY, then call next_pi_no().[m
[32m+[m[32m      const fy = await resolveFY()[m
[32m+[m[32m      if (!fy) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}: no financial year found`); continue }[m
[32m+[m[32m      const { data: piNo, error: noErr } = await supabase.rpc('next_pi_no', { ent_id: fromE.id, fy_id: fy.id })[m
[32m+[m[32m      if (noErr) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}: could not generate PI number — ${noErr.message}`); continue }[m
[32m+[m
       const interstate = meta.is_interstate === 'true' || (fromE.state_code && toE.state_code && fromE.state_code !== toE.state_code)[m
 [m
       const piLines = gLines.map((r, i) => {[m
[36m@@ -246,9 +263,9 @@[m [mfunction PIList() {[m
       }), { taxable_amount: 0, cgst_amount: 0, sgst_amount: 0, igst_amount: 0, total_amount: 0 })[m
 [m
       const { data: pi, error: piErr } = await supabase.from('proforma_invoices').insert({[m
[31m-        pi_date: meta.pi_date, from_entity_id: fromE.id, to_entity_id: toE.id,[m
[31m-        is_interstate: interstate, valid_upto: meta.valid_upto || null,[m
[31m-        notes: meta.notes || null, status: 'draft', ...totals,[m
[32m+[m[32m        pi_date: piDate, from_entity_id: fromE.id, to_entity_id: toE.id,[m
[32m+[m[32m        is_interstate: interstate, valid_upto: validUpto,[m
[32m+[m[32m        notes: meta.notes || null, status: 'draft', pi_no: piNo, financial_year_id: fy.id, ...totals,[m
       }).select().single()[m
 [m
       if (piErr) { errors.push(`PI ${meta.pi_date} ${meta.from_entity}→${meta.to_entity}: ${piErr.message}`); continue }[m
[1mdiff --git a/src/pages/PO/index.jsx b/src/pages/PO/index.jsx[m
[1mindex d462ed1..95f76f7 100644[m
[1m--- a/src/pages/PO/index.jsx[m
[1m+++ b/src/pages/PO/index.jsx[m
[36m@@ -7,7 +7,7 @@[m [mimport {[m
 } from '../../components/UI/index'[m
 import LineItemsEditor, { computeLine, computeTotals } from '../../components/LineItemsEditor'[m
 import { formatINR, toNum } from '../../utils/money'[m
[31m-import { fmtDate, today, currentFYLabel } from '../../utils/dates'[m
[32m+[m[32mimport { fmtDate, today, currentFYLabel, parseFlexibleDate } from '../../utils/dates'[m
 import { buildHSNMap } from '../../utils/hsn'[m
 import DocumentAttachments from '../../components/DocumentAttachments'[m
 import { downloadTemplate, downloadCSV, detectDelimiter } from '../../utils/csvTemplate'[m
[36m@@ -161,6 +161,23 @@[m [mfunction POList() {[m
       const sellerE = entities.find(e => e.short_name?.toLowerCase() === meta.seller_entity?.toLowerCase() || e.name?.toLowerCase() === meta.seller_entity?.toLowerCase())[m
       if (!buyerE)  { errors.push(`Buyer "${meta.buyer_entity}" not found`); continue }[m
       if (!sellerE) { errors.push(`Seller "${meta.seller_entity}" not found`); continue }[m
[32m+[m
[32m+[m[32m      // CHANGED: same fix as PI — accept YYYY-MM-DD or DD-MM-YYYY, normalize to ISO,[m
[32m+[m[32m      // otherwise Postgres throws "date/time field value out of range" on any[m
[32m+[m[32m      // DD-MM-YYYY value where the day exceeds 12.[m
[32m+[m[32m      const poDate = parseFlexibleDate(meta.po_date)[m
[32m+[m[32m      if (!poDate) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}: po_date "${meta.po_date}" is not a valid date — use YYYY-MM-DD or DD-MM-YYYY`); continue }[m
[32m+[m[32m      const deliveryDate = meta.delivery_date ? parseFlexibleDate(meta.delivery_date) : null[m
[32m+[m[32m      if (meta.delivery_date && !deliveryDate) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}: delivery_date "${meta.delivery_date}" is not a valid date`); continue }[m
[32m+[m
[32m+[m[32m      // CHANGED: po_no and financial_year_id are NOT NULL with no DB default —[m
[32m+[m[32m      // previously omitted here, so this insert would have failed on that[m
[32m+[m[32m      // constraint right after the date fix. Mirrors the single-PO create flow.[m
[32m+[m[32m      const fy = await resolveFY()[m
[32m+[m[32m      if (!fy) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}: no financial year found`); continue }[m
[32m+[m[32m      const { data: poNo, error: noErr } = await supabase.rpc('next_po_no', { ent_id: buyerE.id, fy_id: fy.id })[m
[32m+[m[32m      if (noErr) { errors.push(`PO ${meta.po_date} ${meta.buyer_entity}→${meta.seller_entity}: could not generate PO number — ${noErr.message}`); continue }[m
[32m+[m
       const interstate = meta.is_interstate === 'true' || (buyerE.state_code && sellerE.state_code && buyerE.state_code !== sellerE.state_code)[m
       const poLines = gLines.map((r, i) => {[m
         const rate = toNum(r.rate); const qty = toNum(r.qty); const taxable = Math.round(qty * rate)[m
[36m@@ -170,7 +187,7 @@[m [mfunction POList() {[m
         return { line_no: i+1, description: r.description, hsn_code: r.hsn_code, qty, unit: r.unit||'Nos', rate, gst_rate: gstRate, taxable_amount: taxable, cgst_rate: half, cgst_amount: cgst, sgst_rate: half, sgst_amount: cgst, igst_rate: interstate?gstRate:0, igst_amount: igst, total_amount: taxable+igst+cgst+cgst }[m
       })[m
       const totals = poLines.reduce((acc, l) => ({ taxable_amount: acc.taxable_amount+l.taxable_amount, cgst_amount: acc.cgst_amount+l.cgst_amount, sgst_amount: acc.sgst_amount+l.sgst_amount, igst_amount: acc.igst_amount+l.igst_amount, total_amount: acc.total_amount+l.total_amount }), { taxable_amount:0,cgst_amount:0,sgst_amount:0,igst_amount:0,total_amount:0 })[m
[31m-      const { data: po, error: poErr } = await supabase.from('purchase_orders').insert({ po_date: meta.po_date, buyer_entity_id: buyerE.id, seller_entity_id: sellerE.id, is_interstate: interstate, delivery_date: meta.delivery_date||null, notes: meta.notes||null, status: 'open', ...totals }).select().single()[m
[32m+[m[32m      const { data: po, error: poErr } = await supabase.from('purchase_orders').insert({ po_date: poDate, buyer_entity_id: buyerE.id, seller_entity_id: sellerE.id, is_interstate: interstate, delivery_date: deliveryDate, notes: meta.notes||null, status: 'open', po_no: poNo, financial_year_id: fy.id, ...totals }).select().single()[m
       if (poErr) { errors.push(`PO ${meta.po_date}: ${poErr.message}`); continue }[m
       await supabase.from('purchase_order_lines').insert(poLines.map(l => ({ ...l, po_id: po.id })))[m
       created++[m
[1mdiff --git a/src/utils/dates.js b/src/utils/dates.js[m
[1mindex fe6b421..403644c 100644[m
[1m--- a/src/utils/dates.js[m
[1m+++ b/src/utils/dates.js[m
[36m@@ -17,6 +17,27 @@[m [mexport function today() {[m
   return new Date().toISOString().split('T')[0][m
 }[m
 [m
[32m+[m[32m/**[m
[32m+[m[32m * Parse a CSV date cell that may be YYYY-MM-DD (ISO, preferred) or DD-MM-YYYY[m
[32m+[m[32m * / DD/MM/YYYY (common when typed or copied from Excel in India). Returns[m
[32m+[m[32m * ISO YYYY-MM-DD, or null if the value is blank or doesn't match either shape.[m
[32m+[m[32m * Postgres's default DateStyle reads unquoted "15-06-2026" as MDY and throws[m
[32m+[m[32m * "date/time field value out of range" the moment the day exceeds 12 — this[m
[32m+[m[32m * normalizes on the JS side before the value ever reaches the DB.[m
[32m+[m[32m */[m
[32m+[m[32mexport function parseFlexibleDate(raw) {[m
[32m+[m[32m  const s = (raw || '').trim()[m
[32m+[m[32m  if (!s) return null[m
[32m+[m[32m  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)[m
[32m+[m[32m  if (iso) return s[m
[32m+[m[32m  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)[m
[32m+[m[32m  if (dmy) {[m
[32m+[m[32m    const [, d, m, y] = dmy[m
[32m+[m[32m    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`[m
[32m+[m[32m  }[m
[32m+[m[32m  return null[m
[32m+[m[32m}[m
[32m+[m
 /** Current financial year label e.g. "FY 2025-26" */[m
 export function currentFYLabel() {[m
   const now = new Date()[m
