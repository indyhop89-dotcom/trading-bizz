import { useState, useCallback } from 'react'

let _addToast = null

export function useToast() {
  const [toasts, setToasts] = useState([])

  const addToast = useCallback((message, type = 'default', duration = 2800) => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, duration)
  }, [])

  _addToast = addToast

  return { toasts, addToast }
}

// Global toast function — call from anywhere
export function toast(message, type = 'default', duration = 2800) {
  if (_addToast) _addToast(message, type, duration)
}

export function ToastContainer({ toasts }) {
  return (
    <div className="toast-container">
      {toasts.map(t => (
        <div
          key={t.id}
          className={`toast${t.type !== 'default' ? ' toast-' + t.type : ''}`}
        >
          {t.message}
        </div>
      ))}
    </div>
  )
}
