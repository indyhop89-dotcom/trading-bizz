// Keeps a module's LIST page mounted while one of its records is open.
//
// Before: /invoices and /invoices/:id were two separate routes, so opening an
// invoice threw the list away — filters, search, sort, ticked rows and scroll
// position were all gone when you came back.
//
// Now: the list stays mounted (just hidden) underneath, and the record opens
// as a full-screen view on top of it. Closing the record — Back, Cancel, the
// browser's back button, or the sidebar link — shows the same list again,
// exactly as it was left. On return the list is told to re-fetch quietly
// (refreshKey) so what was just saved shows up, without resetting anything.
//
// Usage (inside the element of a `path='/invoices/*'` route):
//   <KeepListMounted List={InvoiceList}>
//     <Route path='new' element={<NewInvoice />} />
//     <Route path=':id' element={<InvoiceDetail />} />
//   </KeepListMounted>
// The List component receives `refreshKey` (0 on first mount, +1 on every
// return) and should re-load silently when it changes.
import { useLayoutEffect, useEffect, useRef, useState } from 'react'
import { Routes, useParams } from 'react-router-dom'

export default function KeepListMounted({ List, children }) {
  // Whatever follows the module's base path: '' on the list, 'new' or an id otherwise.
  const rest = (useParams()['*'] || '').replace(/^\/+|\/+$/g, '')
  const atList = rest === ''
  const [refreshKey, setRefreshKey] = useState(0)
  const wrapRef     = useRef(null)
  const listScroll  = useRef(0)
  const atListRef   = useRef(atList)
  const wasAtList   = useRef(atList)
  atListRef.current = atList

  // Remember how far down the list was scrolled (the app scrolls inside <main>).
  useEffect(() => {
    const main = wrapRef.current?.closest('main')
    if (!main) return
    const onScroll = () => { if (atListRef.current) listScroll.current = main.scrollTop }
    main.addEventListener('scroll', onScroll, { passive: true })
    return () => main.removeEventListener('scroll', onScroll)
  }, [])

  useLayoutEffect(() => {
    const main = wrapRef.current?.closest('main')
    if (atList && !wasAtList.current) {
      setRefreshKey(k => k + 1)
      if (main) main.scrollTop = listScroll.current
    } else if (!atList && main) {
      main.scrollTop = 0
    }
    wasAtList.current = atList
  }, [atList, rest])

  return (
    <>
      <div ref={wrapRef} style={{ display: atList ? 'block' : 'none' }}>
        <List refreshKey={refreshKey} />
      </div>
      {!atList && <Routes>{children}</Routes>}
    </>
  )
}
