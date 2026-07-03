// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// CHANGED: mock the two external dependencies — Supabase (data) and
// react-router-dom's navigate (routing side effect). Nothing else mocked.
vi.mock('../../supabaseClient', () => ({
  supabase: { from: vi.fn() },
}))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}))

import { supabase } from '../../supabaseClient'
import NotificationBell from '../NotificationBell.jsx'

function makeNotifs(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    notification_type: 'system',
    title: `Notification ${i}`,
    message: `Message ${i}`,
    created_at: '2026-06-01T10:00:00Z',
    is_read: false,
    is_dismissed: false,
  }))
}

function mockLoadNotifs(data) {
  const builder = {
    select: vi.fn(() => builder),
    eq:     vi.fn(() => builder),
    order:  vi.fn(() => builder),
    limit:  vi.fn(() => builder),
    update: vi.fn(() => builder),
    then:   (resolve) => resolve({ data, error: null }),
  }
  supabase.from.mockReturnValue(builder)
  return builder
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// ─── Badge / count display ───────────────────────────────────────────────────

describe('NotificationBell — unread badge', () => {
  it('shows no badge when there are no unread notifications', async () => {
    mockLoadNotifs([])
    render(<NotificationBell />)
    await waitFor(() => expect(supabase.from).toHaveBeenCalled())
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('shows the exact count for 1-9 unread notifications', async () => {
    mockLoadNotifs(makeNotifs(3))
    render(<NotificationBell />)
    expect(await screen.findByText('3')).toBeInTheDocument()
  })

  it('caps the badge at "9+" for 10 or more unread notifications', async () => {
    mockLoadNotifs(makeNotifs(12))
    render(<NotificationBell />)
    expect(await screen.findByText('9+')).toBeInTheDocument()
  })
})

// ─── Dropdown open/close ─────────────────────────────────────────────────────

describe('NotificationBell — dropdown toggle', () => {
  it('does not show the dropdown before the bell is clicked', async () => {
    mockLoadNotifs(makeNotifs(2))
    render(<NotificationBell />)
    await waitFor(() => expect(supabase.from).toHaveBeenCalled())
    expect(screen.queryByText('Notifications')).not.toBeInTheDocument()
  })

  it('opens the dropdown when the bell is clicked', async () => {
    mockLoadNotifs(makeNotifs(2))
    render(<NotificationBell />)
    fireEvent.click(screen.getByText('🔔'))
    expect(await screen.findByText(/Notifications/)).toBeInTheDocument()
  })

  it('closes the dropdown on a second bell click', async () => {
    mockLoadNotifs(makeNotifs(2))
    render(<NotificationBell />)
    const bell = screen.getByText('🔔')
    fireEvent.click(bell)
    await screen.findByText(/Notifications/)
    fireEvent.click(bell)
    await waitFor(() => expect(screen.queryByText('Notification 0')).not.toBeInTheDocument())
  })

  it('closes the dropdown on an outside click', async () => {
    mockLoadNotifs(makeNotifs(2))
    render(
      <div>
        <div data-testid="outside">outside area</div>
        <NotificationBell />
      </div>
    )
    fireEvent.click(screen.getByText('🔔'))
    await screen.findByText('Notification 0')
    fireEvent.mouseDown(screen.getByTestId('outside'))
    await waitFor(() => expect(screen.queryByText('Notification 0')).not.toBeInTheDocument())
  })
})

// ─── Empty / populated list content ──────────────────────────────────────────

describe('NotificationBell — list content', () => {
  it('shows the "all caught up" empty state when there are no notifications', async () => {
    mockLoadNotifs([])
    render(<NotificationBell />)
    fireEvent.click(screen.getByText('🔔'))
    expect(await screen.findByText(/All caught up/)).toBeInTheDocument()
  })

  it('renders title and message for each notification', async () => {
    mockLoadNotifs(makeNotifs(2))
    render(<NotificationBell />)
    fireEvent.click(screen.getByText('🔔'))
    expect(await screen.findByText('Notification 0')).toBeInTheDocument()
    expect(screen.getByText('Message 0')).toBeInTheDocument()
    expect(screen.getByText('Notification 1')).toBeInTheDocument()
  })

  it('falls back to the "system" icon config for an unknown notification_type', async () => {
    mockLoadNotifs([{ id: 'n1', notification_type: 'totally_unknown_type', title: 'X', message: 'Y', created_at: '2026-06-01', is_read: false, is_dismissed: false }])
    render(<NotificationBell />)
    fireEvent.click(screen.getByText('🔔'))
    await screen.findByText('X')
    // system's icon is also 🔔 — so with the dropdown open there should be
    // exactly two: the bell button itself, and this row's fallback icon.
    expect(screen.getAllByText('🔔')).toHaveLength(2)
  })
})

// ─── Mark as read ─────────────────────────────────────────────────────────────

describe('NotificationBell — mark as read', () => {
  it('calls supabase update with is_read:true and the correct id when the check button is clicked', async () => {
    const builder = mockLoadNotifs(makeNotifs(1))
    render(<NotificationBell />)
    fireEvent.click(screen.getByText('🔔'))
    await screen.findByText('Notification 0')

    fireEvent.click(screen.getByText('✓'))

    await waitFor(() => expect(builder.update).toHaveBeenCalledWith({ is_read: true }))
    expect(builder.eq).toHaveBeenCalledWith('id', 'n0')
  })

  it('does not close the dropdown when marking a notification as read (event does not bubble to bell)', async () => {
    mockLoadNotifs(makeNotifs(1))
    render(<NotificationBell />)
    fireEvent.click(screen.getByText('🔔'))
    await screen.findByText('Notification 0')

    fireEvent.click(screen.getByText('✓'))

    // Dropdown container should still be present right after the click
    // (stopPropagation prevents the outside-click handler from firing)
    expect(screen.getByText(/Notifications/)).toBeInTheDocument()
  })
})

// ─── Navigation ───────────────────────────────────────────────────────────────

describe('NotificationBell — "View all" navigation', () => {
  it('navigates to /notifications and closes the dropdown when "View all" is clicked', async () => {
    mockLoadNotifs(makeNotifs(1))
    render(<NotificationBell />)
    fireEvent.click(screen.getByText('🔔'))
    await screen.findByText('View all')

    fireEvent.click(screen.getByText('View all'))

    expect(mockNavigate).toHaveBeenCalledWith('/notifications')
    await waitFor(() => expect(screen.queryByText('View all')).not.toBeInTheDocument())
  })
})

// ─── Edge case — Supabase returns null data ─────────────────────────────────

describe('NotificationBell — null data handling', () => {
  it('treats a null data response from Supabase as an empty list, not a crash', async () => {
    mockLoadNotifs(null)
    render(<NotificationBell />)
    fireEvent.click(screen.getByText('🔔'))
    expect(await screen.findByText(/All caught up/)).toBeInTheDocument()
  })
})
