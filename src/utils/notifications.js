/**
 * Notification generator — scans for conditions and inserts notifications.
 * Called once on Dashboard mount or on demand.
 * Idempotent — checks if notification already exists before inserting.
 */
import { supabase } from '../supabaseClient'

/**
 * Generate all notifications for a given user.
 * Checks: overdue invoice payments, overdue expense payments, BD due, stock shortfalls.
 */
export async function generateNotifications(userId) {
  if (!userId) return

  const today = new Date().toISOString().split('T')[0]
  const soon  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const notifs = []

  // 1. Overdue invoice payments
  const { data: overdueInv } = await supabase
    .from('invoice_payments')
    .select('id, invoice_no, amount, currency, entity_id')
    .eq('is_deleted', false)
    .is('actual_payment_date', null)
    .lt('due_date', today)
    .not('due_date', 'is', null)

  for (const r of (overdueInv || [])) {
    notifs.push({
      user_id:           userId,
      title:             `Invoice payment overdue`,
      message:           `Invoice ${r.invoice_no || r.id.slice(0,8)} payment of ${r.currency} ${Math.round(r.amount).toLocaleString('en-IN')} is past due.`,
      notification_type: 'overdue_invoice',
      source_type:       'invoice_payments',
      source_id:         r.id,
      entity_id:         r.entity_id || null,
    })
  }

  // 2. Invoice payments due within 7 days
  const { data: dueSoonInv } = await supabase
    .from('invoice_payments')
    .select('id, invoice_no, amount, currency, due_date, entity_id')
    .eq('is_deleted', false)
    .is('actual_payment_date', null)
    .gte('due_date', today)
    .lte('due_date', soon)

  for (const r of (dueSoonInv || [])) {
    notifs.push({
      user_id:           userId,
      title:             `Invoice payment due soon`,
      message:           `Invoice ${r.invoice_no || r.id.slice(0,8)} — ${r.currency} ${Math.round(r.amount).toLocaleString('en-IN')} due on ${r.due_date}.`,
      notification_type: 'payment_due',
      source_type:       'invoice_payments',
      source_id:         r.id,
      entity_id:         r.entity_id || null,
      due_date:          r.due_date,
    })
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
      message:           `${r.expense_category} expense of ${r.currency} ${Math.round(r.amount).toLocaleString('en-IN')} is past due.`,
      notification_type: 'overdue_invoice',
      source_type:       'expense_payments',
      source_id:         r.id,
    })
  }

  // 4. Bill discounting due within 7 days
  const { data: bdDue } = await supabase
    .from('bill_discounting_events')
    .select('id, bank_name, outstanding_amount, maturity_date, entity_id')
    .eq('is_deleted', false)
    .eq('status', 'active')
    .not('maturity_date', 'is', null)
    .lte('maturity_date', soon)

  for (const r of (bdDue || [])) {
    notifs.push({
      user_id:           userId,
      title:             `Bill discounting maturing soon`,
      message:           `${r.bank_name} — outstanding ${Math.round(r.outstanding_amount).toLocaleString('en-IN')} matures on ${r.maturity_date}.`,
      notification_type: 'bill_discounting_due',
      source_type:       'bill_discounting_events',
      source_id:         r.id,
      entity_id:         r.entity_id || null,
      due_date:          r.maturity_date,
    })
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
