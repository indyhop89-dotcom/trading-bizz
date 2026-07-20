/**
 * Notification generator — scans for conditions and inserts notifications.
 * Called once on Dashboard mount or on demand.
 * Idempotent — checks if notification already exists before inserting.
 */
import { supabase } from '../supabaseClient'
import { buildActualStockMap, fetchStockMovementData } from './stock'
import { computeInvoiceOutstanding, groupTranchesByInvoice } from './payments'
import { formatINR, formatNumberIN } from './money'

/**
 * Generate all notifications for a given user.
 * Checks: overdue invoice payments, overdue expense payments, BD due, stock shortfalls.
 */
export async function generateNotifications(userId) {
  if (!userId) return

  const today = new Date().toISOString().split('T')[0]
  const soon  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const notifs = []

  // 1 & 2. Invoice payment overdue / due soon — computed per INVOICE, aggregating
  // all payment tranches recorded against it (invoice_payments is now one row
  // per payment tranche, not a single snapshot of the whole invoice).
  const { data: invForNotif } = await supabase
    .from('invoices')
    .select('id, invoice_no, total_amount, due_date, buyer_entity_id')
    .eq('is_deleted', false)
    .neq('status', 'cancelled')
    .not('due_date', 'is', null)

  const invIds = (invForNotif || []).map(i => i.id)
  let tranchesByInvoice = new Map()
  if (invIds.length > 0) {
    const { data: tranches } = await supabase
      .from('invoice_payments')
      .select('invoice_id, amount, tds_amount, adjustments')
      .eq('is_deleted', false)
      .in('invoice_id', invIds)
    tranchesByInvoice = groupTranchesByInvoice(tranches)
  }

  for (const inv of (invForNotif || [])) {
    const { pending } = computeInvoiceOutstanding(inv, tranchesByInvoice.get(inv.id))
    if (pending <= 0) continue
    if (inv.due_date < today) {
      notifs.push({
        user_id:           userId,
        title:             `Invoice payment overdue`,
        message:           `Invoice ${inv.invoice_no || inv.id.slice(0,8)} — ${formatINR(pending)} pending, past due.`,
        notification_type: 'overdue_invoice',
        source_type:       'invoices',
        source_id:         inv.id,
        entity_id:         inv.buyer_entity_id || null,
      })
    } else if (inv.due_date <= soon) {
      notifs.push({
        user_id:           userId,
        title:             `Invoice payment due soon`,
        message:           `Invoice ${inv.invoice_no || inv.id.slice(0,8)} — ${formatINR(pending)} due on ${inv.due_date}.`,
        notification_type: 'payment_due',
        source_type:       'invoices',
        source_id:         inv.id,
        entity_id:         inv.buyer_entity_id || null,
        due_date:          inv.due_date,
      })
    }
  }

  // 3. Expense payments overdue
  const { data: overdueExp } = await supabase
    .from('expense_payments')
    .select('id, expense_category, amount, currency, entity_id:from_entity_id')
    .eq('is_deleted', false)
    .is('actual_payment_date', null)
    .lt('due_date', today)
    .not('due_date', 'is', null)

  for (const r of (overdueExp || [])) {
    notifs.push({
      user_id:           userId,
      title:             `Expense payment overdue`,
      message:           `${r.expense_category} expense of ${r.currency} ${formatNumberIN(r.amount)} is past due.`,
      notification_type: 'overdue_invoice',
      source_type:       'expense_payments',
      source_id:         r.id,
    })
  }

  // 4. Bill discounting due within 7 days
  const { data: bdDue } = await supabase
    .from('bill_discounting_events')   // CHANGED: was 'bill_discounting', which doesn't exist as a live table
    .select('id, bank_name, outstanding_amount, maturity_date, entity_id')
    .eq('is_deleted', false)
    .eq('status', 'active')
    .not('maturity_date', 'is', null)
    .lte('maturity_date', soon)

  for (const r of (bdDue || [])) {
    notifs.push({
      user_id:           userId,
      title:             `Bill discounting maturing soon`,
      message:           `${r.bank_name} — outstanding ${formatINR(r.outstanding_amount)} matures on ${r.maturity_date}.`,
      notification_type: 'bill_discounting_due',
      source_type:       'bill_discounting',
      source_id:         r.id,
      entity_id:         r.entity_id || null,
      due_date:          r.maturity_date,
    })
  }

  // 5 & 6. Planned (PI) / billed (invoice) quantity exceeding actual
  // available stock — reuses the same actual-stock calc that powers the
  // Stock page, grouped per source document (one notification per
  // over-committed PI/invoice, not per line, to match this function's
  // existing per-source_id dedup granularity).
  const actualMap = buildActualStockMap(await fetchStockMovementData())
  function availableFor(entityId, productId) {
    return actualMap[`${entityId}__${productId}`]?.actual_qty ?? 0
  }

  const { data: piLinesForNotif } = await supabase
    .from('proforma_invoice_lines')
    .select('qty, product_id, pi:pi_id(id, pi_no, from_entity_id, status)')
    .not('pi', 'is', null)
    .neq('pi.status', 'cancelled')

  const piExceedGroups = new Map()
  for (const l of (piLinesForNotif || [])) {
    if (!l.pi || !l.product_id) continue
    if ((Number(l.qty) || 0) <= availableFor(l.pi.from_entity_id, l.product_id)) continue
    const g = piExceedGroups.get(l.pi.id) || { pi_no: l.pi.pi_no, entity_id: l.pi.from_entity_id, count: 0 }
    g.count++
    piExceedGroups.set(l.pi.id, g)
  }
  for (const [piId, g] of piExceedGroups) {
    notifs.push({
      user_id:           userId,
      title:             'PI planned quantity exceeds stock',
      message:           `PI ${g.pi_no || piId.slice(0,8)} plans more quantity than is actually available on ${g.count} line item(s).`,
      notification_type: 'stock_shortfall',
      source_type:       'proforma_invoices',
      source_id:         piId,
      entity_id:         g.entity_id || null,
    })
  }

  // CHANGED: invoice_type='purchase' rows WITH a source_invoice_id are the
  // auto-created buyer-side bookkeeping mirror of a 'sales' invoice — same
  // physical movement, so excluded here to avoid a duplicate/confusing
  // second alert. A purchase invoice with no source_invoice_id was entered
  // manually and is the only record of that transaction — it still needs
  // this check (see stock.js buildActualStockMap for the same distinction).
  const { data: invLinesForNotif } = await supabase
    .from('invoice_lines')
    .select('qty, product_id, invoice:invoice_id(id, invoice_no, seller_entity_id, status, invoice_type, source_invoice_id)')
    .not('invoice', 'is', null)
    .neq('invoice.status', 'cancelled')

  const invExceedGroups = new Map()
  for (const l of (invLinesForNotif || [])) {
    if (!l.invoice || (l.invoice.invoice_type === 'purchase' && l.invoice.source_invoice_id) || !l.product_id) continue
    if ((Number(l.qty) || 0) <= availableFor(l.invoice.seller_entity_id, l.product_id)) continue
    const g = invExceedGroups.get(l.invoice.id) || { invoice_no: l.invoice.invoice_no, entity_id: l.invoice.seller_entity_id, count: 0 }
    g.count++
    invExceedGroups.set(l.invoice.id, g)
  }
  for (const [invId, g] of invExceedGroups) {
    notifs.push({
      user_id:           userId,
      title:             'Billed quantity exceeds stock',
      message:           `Invoice ${g.invoice_no || invId.slice(0,8)} bills more quantity than is actually available on ${g.count} line item(s).`,
      notification_type: 'stock_shortfall',
      source_type:       'invoices',
      source_id:         invId,
      entity_id:         g.entity_id || null,
    })
  }

  // 7. Missing product_id on PI/invoice lines — these are invisible to
  // every stock calculation above, so surface them as their own alert.
  const missingPiGroups = new Map()
  for (const l of (piLinesForNotif || [])) {
    if (!l.pi || l.product_id || !(Number(l.qty) > 0)) continue
    const g = missingPiGroups.get(l.pi.id) || { pi_no: l.pi.pi_no, entity_id: l.pi.from_entity_id, count: 0 }
    g.count++
    missingPiGroups.set(l.pi.id, g)
  }
  for (const [piId, g] of missingPiGroups) {
    notifs.push({
      user_id:           userId,
      title:             'PI has line(s) with no product link',
      message:           `PI ${g.pi_no || piId.slice(0,8)} has ${g.count} line item(s) with no product — these are invisible to stock tracking.`,
      notification_type: 'missing_product_mapping',
      source_type:       'proforma_invoices',
      source_id:         piId,
      entity_id:         g.entity_id || null,
    })
  }

  const missingInvGroups = new Map()
  for (const l of (invLinesForNotif || [])) {
    if (!l.invoice || l.product_id || !(Number(l.qty) > 0)) continue
    const g = missingInvGroups.get(l.invoice.id) || { invoice_no: l.invoice.invoice_no, entity_id: l.invoice.seller_entity_id, count: 0 }
    g.count++
    missingInvGroups.set(l.invoice.id, g)
  }
  for (const [invId, g] of missingInvGroups) {
    notifs.push({
      user_id:           userId,
      title:             'Invoice has line(s) with no product link',
      message:           `Invoice ${g.invoice_no || invId.slice(0,8)} has ${g.count} line item(s) with no product — these are invisible to stock tracking.`,
      notification_type: 'missing_product_mapping',
      source_type:       'invoices',
      source_id:         invId,
      entity_id:         g.entity_id || null,
    })
  }

  // 8. Duplicate invoice numbers — the save-time check in Invoices/PI
  // already blocks this for a single user's normal flow, but a CSV import
  // or a race between two people saving at once can still slip a duplicate
  // through, and duplicate invoice numbers cause GST filing mismatches.
  const { data: allInvNos } = await supabase
    .from('invoices')
    .select('id, invoice_no')
    .eq('is_deleted', false)
    .not('invoice_no', 'is', null)

  const byInvoiceNo = new Map()
  for (const inv of (allInvNos || [])) {
    const key = (inv.invoice_no || '').trim().toLowerCase()
    if (!key) continue
    if (!byInvoiceNo.has(key)) byInvoiceNo.set(key, [])
    byInvoiceNo.get(key).push(inv)
  }
  for (const group of byInvoiceNo.values()) {
    if (group.length < 2) continue
    notifs.push({
      user_id:           userId,
      title:             'Duplicate invoice number',
      message:           `Invoice number "${group[0].invoice_no}" is used by ${group.length} invoices — this can cause GST filing mismatches.`,
      notification_type: 'duplicate_invoice_number',
      source_type:       'invoices',
      source_id:         group[0].id,
    })
  }

  // 9. Invoices referencing an entity that's since been deactivated or
  // soft-deleted — a sign of stale master data (e.g. an entity was merged
  // or retired after this invoice was raised).
  const { data: entityRows } = await supabase.from('entities').select('id, is_active, is_deleted')
  const inactiveEntitySet = new Set((entityRows || []).filter(e => !e.is_active || e.is_deleted).map(e => e.id))
  if (inactiveEntitySet.size > 0) {
    const { data: invEntityCheck } = await supabase
      .from('invoices')
      .select('id, invoice_no, seller_entity_id, buyer_entity_id')
      .eq('is_deleted', false)
      .neq('status', 'cancelled')
    for (const inv of (invEntityCheck || [])) {
      if (inactiveEntitySet.has(inv.seller_entity_id) || inactiveEntitySet.has(inv.buyer_entity_id)) {
        notifs.push({
          user_id:           userId,
          title:             'Invoice references an inactive entity',
          message:           `Invoice ${inv.invoice_no || inv.id.slice(0,8)} involves an entity that is now inactive or deleted — verify it's still correct.`,
          notification_type: 'entity_access_mismatch',
          source_type:       'invoices',
          source_id:         inv.id,
        })
      }
    }
  }

  // 10. Negative stock risk — any entity+product combination where Actual
  // Stock has gone negative right now. Grouped per entity (one alert per
  // entity, not per product) so several negative products at the same
  // entity don't flood the list — it's the same underlying problem either
  // way (more has been billed out than was ever received in).
  const negativeByEntity = new Map()
  for (const row of Object.values(actualMap)) {
    if (row.actual_qty >= 0 || !row.product_id) continue
    negativeByEntity.set(row.entity_id, (negativeByEntity.get(row.entity_id) || 0) + 1)
  }
  for (const [entityId, count] of negativeByEntity) {
    notifs.push({
      user_id:           userId,
      title:             'Negative stock risk',
      message:           `${count} product(s) at this entity currently show negative Actual Stock — more has been billed out than was ever received.`,
      notification_type: 'negative_stock_risk',
      source_type:       'entities',
      source_id:         entityId,
      entity_id:         entityId,
    })
  }

  // 11. Invalid date data — invoice dated outside every configured
  // financial year (usually a typo: wrong century, swapped day/month), or
  // an E-way Bill dated before the invoice it belongs to (physically
  // impossible — goods can't have moved before the invoice existed).
  const { data: fyRows } = await supabase.from('financial_years').select('start_date, end_date')
  function inAnyFY(dateStr) {
    if (!dateStr || !fyRows?.length) return true // nothing configured to check against — don't false-positive
    return fyRows.some(fy => dateStr >= fy.start_date && dateStr <= fy.end_date)
  }
  const { data: invDateCheck } = await supabase
    .from('invoices')
    .select('id, invoice_no, invoice_date, eway_bill_date')
    .eq('is_deleted', false)
    .neq('status', 'cancelled')
  for (const inv of (invDateCheck || [])) {
    if (!inAnyFY(inv.invoice_date)) {
      notifs.push({
        user_id:           userId,
        title:             'Invoice date outside any financial year',
        message:           `Invoice ${inv.invoice_no || inv.id.slice(0,8)} is dated ${inv.invoice_date}, which doesn't fall in any configured financial year — check for a typo.`,
        notification_type: 'invalid_date_mismatch',
        source_type:       'invoices',
        source_id:         inv.id,
      })
    } else if (inv.eway_bill_date && inv.eway_bill_date < inv.invoice_date) {
      notifs.push({
        user_id:           userId,
        title:             'E-way Bill dated before invoice',
        message:           `Invoice ${inv.invoice_no || inv.id.slice(0,8)}'s E-way Bill (${inv.eway_bill_date}) is dated before the invoice itself (${inv.invoice_date}) — check for a data entry error.`,
        notification_type: 'invalid_date_mismatch',
        source_type:       'invoices',
        source_id:         inv.id,
      })
    }
  }

  if (notifs.length === 0) return

  // Deduplicate — don't insert if same source_type + source_id + type already unread
  const { data: existing } = await supabase
    .from('notifications')
    .select('source_id, notification_type')
    .eq('user_id', userId)
    .eq('is_read', false)
    .eq('is_dismissed', false)

  const existingSet = new Set((existing || []).map(e => `${e.source_id}__${e.notification_type}`))

  const toInsert = notifs.filter(n => !existingSet.has(`${n.source_id}__${n.notification_type}`))

  if (toInsert.length > 0) {
    await supabase.from('notifications').insert(toInsert)
  }
}
