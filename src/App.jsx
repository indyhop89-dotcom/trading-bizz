import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import Layout from './components/Layout/Layout'
import { Spinner } from './components/UI/index'

import Login            from './pages/Login'
import Dashboard        from './pages/Dashboard/index'
import Entities         from './pages/Entities/index'
import Stock            from './pages/Stock/index'
import Orders           from './pages/Orders/index'
import PI               from './pages/PI/index'
import PO               from './pages/PO/index'
import Invoices         from './pages/Invoices/index'
import CreditDebitNotes from './pages/CreditDebitNotes/index'
import Payments         from './pages/Payments/index'
import Expenses         from './pages/Expenses/index'
import BillDiscounting  from './pages/BillDiscounting/index'
import Reports          from './pages/Reports/index'
import Notifications    from './pages/Notifications/index'
import Reconciliation   from './pages/Reconciliation/index'
import Settings         from './pages/Settings/index'

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
              <Route path='*'                     element={<Navigate to='/' replace />} />
            </Routes>
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
