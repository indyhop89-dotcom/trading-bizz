// Ctrl+Enter (Cmd+Enter on a Mac) = "do the main thing on this screen".
//
//   • In a popup form      → presses its Save / Create / Record button
//   • On a report          → Run Report
//   • On an Invoice / PI / PO create or edit page → Save
//
// How the button is found (no page needs its own key handler):
//   1. Look only inside the top-most open popup, if there is one; otherwise the page.
//   2. Prefer a button marked for the shortcut (<Btn shortcut>, or data-ctrl-enter).
//   3. In a popup with no marked button, use its last primary (blue) button —
//      that is always the form's Save.
// On a page, only marked buttons are used, so the shortcut can never trigger
// something like "+ New" or "Submit" by accident. Hidden and disabled buttons
// are ignored, and delete confirmations (red button) are never triggered.
import { useEffect } from 'react'

// On screen right now (not inside a hidden list or a closed section) and usable.
const onScreen = el => !!el && el.getClientRects().length > 0
const visible = el => onScreen(el) && !el.disabled

export function findCtrlEnterTarget(root = document) {
  const modals = [...root.querySelectorAll('[data-modal]')].filter(onScreen)
  const modal = modals[modals.length - 1] || null
  const scope = modal || root
  const marked = [...scope.querySelectorAll('button[data-ctrl-enter]')].filter(visible)
  if (marked.length) return marked[marked.length - 1]
  if (!modal) return null
  const primary = [...modal.querySelectorAll('button[data-variant="primary"]')].filter(visible)
  return primary[primary.length - 1] || null
}

export function useCtrlEnter() {
  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.repeat) return
      const target = findCtrlEnterTarget()
      if (!target) return
      e.preventDefault()
      // Leave the field being typed in first, so anything that saves or
      // formats on leaving the field is applied before the button is pressed.
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()
      setTimeout(() => { if (visible(target)) target.click() }, 0)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
