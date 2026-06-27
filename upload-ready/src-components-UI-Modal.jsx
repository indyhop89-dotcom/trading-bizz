export function Modal({ open, onClose, title, children, footer, size = '' }) {
  if (!open) return null
  return (
    <div className="modal-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`modal-box ${size === 'sm' ? 'modal-box-sm' : size === 'lg' ? 'modal-box-lg' : ''}`}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

export function ConfirmModal({ open, onClose, onConfirm, title, message, danger }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title || 'Confirm'}
      size="sm"
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => { onConfirm(); onClose(); }}
          >
            {danger ? 'Delete' : 'Confirm'}
          </button>
        </>
      }
    >
      <div className={`alert ${danger ? 'alert-danger' : 'alert-warn'}`}>{message}</div>
    </Modal>
  )
}
