import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './hooks/useAuth'
import { useToast, ToastContainer } from './components/UI/Toast'
import { Layout } from './components/Layout'
import LoginPage from './pages/Login'
import DashboardPage from './pages/Dashboard'
import EntitiesPage from './pages/Entities'
import StockPage from './pages/Stock'
import OrdersPage from './pages/Orders'
import PIPage from './pages/PI'
import POPage from './pages/PO'
import InvoicesPage from './pages/Invoices'
import PaymentsPage from './pages/Payments'
import ExpensesPage from './pages/Expenses'
import BillDiscountingPage from './pages/BillDiscounting'
import ReportsPage from './pages/Reports'
import SettingsPage from './pages/Settings'
import { Loading } from './components/UI'

function AppRoutes() {
  const { user, profile, loading, signOut } = useAuth()
  const { toasts, addToast } = useToast()

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loading message="Loading Trading Bizz…" />
      </div>
    )
  }

  if (!user) return <LoginPage />

  return (
    <>
      <Layout user={profile} onSignOut={signOut}>
        <Routes>
          <Route path="/"             element={<DashboardPage />} />
          <Route path="/orders/*"     element={<OrdersPage />} />
          <Route path="/entities/*"   element={<EntitiesPage />} />
          <Route path="/stock/*"      element={<StockPage />} />
          <Route path="/pi/*"         element={<PIPage />} />
          <Route path="/po/*"         element={<POPage />} />
          <Route path="/invoices/*"   element={<InvoicesPage />} />
          <Route path="/payments/*"   element={<PaymentsPage />} />
          <Route path="/expenses/*"   element={<ExpensesPage />} />
          <Route path="/discounting/*" element={<BillDiscountingPage />} />
          <Route path="/reports/*"    element={<ReportsPage />} />
          <Route path="/settings/*"   element={<SettingsPage />} />
          <Route path="*"             element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
      <ToastContainer toasts={toasts} />
    </>
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
