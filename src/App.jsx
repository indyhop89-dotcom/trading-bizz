import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import Layout from './components/Layout/Layout'
import { Spinner } from './components/UI/index'

// Login loads eagerly — it's the very first thing an unauthenticated visitor
// sees, and it's small. Every other page is lazy-loaded: the app was one
// 1.2MB bundle regardless of which page you opened first, so a route-level
// split (one chunk per page, fetched only when its route is visited) cuts
// first-load size roughly in half without touching page behavior. This is
// also why utils/documentBuilders.js exists — Orders' per-leg doc generation
// needed buildPIDoc/buildPODoc/buildInvoiceDoc without statically importing
// the entire PI/PO/Invoices page modules (which would force them to load
// eagerly alongside Orders, defeating the split for three of the biggest
// pages).
import Login             from './pages/Login'
const Dashboard        = lazy(() => import('./pages/Dashboard/index'))
const Entities         = lazy(() => import('./pages/Entities/index'))
const Stock            = lazy(() => import('./pages/Stock/index'))
const Orders           = lazy(() => import('./pages/Orders/index'))
const PI               = lazy(() => import('./pages/PI/index'))
const PO               = lazy(() => import('./pages/PO/index'))
const Invoices         = lazy(() => import('./pages/Invoices/index'))
const CreditDebitNotes = lazy(() => import('./pages/CreditDebitNotes/index'))
const Payments         = lazy(() => import('./pages/Payments/index'))
const Expenses         = lazy(() => import('./pages/Expenses/index'))
const BillDiscounting  = lazy(() => import('./pages/BillDiscounting/index'))
const Reports          = lazy(() => import('./pages/Reports/index'))
const Notifications    = lazy(() => import('./pages/Notifications/index'))
const Reconciliation   = lazy(() => import('./pages/Reconciliation/index'))
const Settings         = lazy(() => import('./pages/Settings/index'))
const DocumentDatabase = lazy(() => import('./pages/DocumentDatabase/index'))

function RouteFallback() {
  return (
    <div style={{ padding: '80px 0', display: 'flex', justifyContent: 'center' }}>
      <Spinner size={28} />
    </div>
  )
}

function AuthGuard({ children }) {
  const { user, loading } = useAuth()
  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f5f0e8' }}>
      <Spinner size={32} />
    </div>
  )
  if (!user) return <Navigate to='/login' replace />
  return children
}

function AppRoutes() {
  const { user } = useAuth()
  return (
    <Routes>
      <Route path='/login' element={user ? <Navigate to='/' replace /> : <Login />} />
      <Route path='/*' element={
        <AuthGuard>
          <Layout>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path='/'                     element={<Dashboard />} />
                <Route path='/entities/*'           element={<Entities />} />
                <Route path='/stock/*'              element={<Stock />} />
                <Route path='/orders/*'             element={<Orders />} />
                <Route path='/pi/*'                 element={<PI />} />
                <Route path='/po/*'                 element={<PO />} />
                <Route path='/invoices/*'           element={<Invoices />} />
                <Route path='/credit-debit-notes/*' element={<CreditDebitNotes />} />
                <Route path='/payments/*'           element={<Payments />} />
                <Route path='/expenses/*'           element={<Expenses />} />
                <Route path='/bill-discounting/*'   element={<BillDiscounting />} />
                <Route path='/reports/*'            element={<Reports />} />
                <Route path='/notifications/*'      element={<Notifications />} />
                <Route path='/reconciliation/*'     element={<Reconciliation />} />
                <Route path='/settings/*'           element={<Settings />} />
                <Route path='/documents/*'          element={<DocumentDatabase />} />
                <Route path='*'                     element={<Navigate to='/' replace />} />
              </Routes>
            </Suspense>
          </Layout>
        </AuthGuard>
      } />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
