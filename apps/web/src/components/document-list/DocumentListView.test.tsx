// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentListView } from './DocumentListView.js'

afterEach(cleanup)

const NOW = '2026-08-11T00:00:00Z'
const OLDER = '2026-08-01T00:00:00Z'

function rows() {
  return [
    { path: 'alpha', displayName: 'Alpha', updatedAt: OLDER, kind: 'spatial' as const },
    { path: 'notes', displayName: 'Notes', updatedAt: NOW, kind: 'markdown' as const },
  ]
}

function renderList(overrides: Partial<Parameters<typeof DocumentListView>[0]> = {}) {
  const onOpen = vi.fn()
  const onCreate = vi.fn()
  const utils = render(
    <DocumentListView rows={rows()} onOpen={onOpen} onCreate={onCreate} {...overrides} />,
    // React 18 delegates events to the root; Radix portals render into
    // document.body, so the body must be the React root for portal events.
    { container: document.body },
  )
  return { onOpen, onCreate, ...utils }
}

describe('DocumentListView', () => {
  it('renders rows in caller order (pinned-first arrays survive) and filters by search', () => {
    // rows() lists alpha (older) BEFORE notes (newer): a component that
    // re-sorts by recency would flip them, discarding the caller's
    // pinned-first ordering. Order is the caller's contract.
    renderList()
    const cards = screen.getAllByTestId('document-list-card')
    expect(within(cards[0]!).getByText('Alpha')).toBeTruthy()
    expect(within(cards[1]!).getByText('Notes')).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search canvases' }), {
      target: { value: 'alp' },
    })
    expect(screen.getAllByTestId('document-list-card')).toHaveLength(1)
    expect(screen.getByText('Alpha')).toBeTruthy()
  })

  it('says "No canvases match." when search filters everything out', () => {
    renderList()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search canvases' }), {
      target: { value: 'zzz' },
    })
    expect(screen.queryAllByTestId('document-list-card')).toHaveLength(0)
    expect(screen.getByText('No canvases match.')).toBeTruthy()
  })

  it('createDisabled reaches menu items already open when the busy state flips', async () => {
    // The menu can be open BEFORE a create starts (pick an entry, create runs,
    // menu still mounted): the items must go dead with the trigger, or they
    // remain a live path to a second create.
    const onOpen = vi.fn()
    const onCreate = vi.fn()
    const view = render(<DocumentListView rows={rows()} onOpen={onOpen} onCreate={onCreate} />, {
      container: document.body,
    })
    fireEvent.pointerDown(screen.getByRole('button', { name: 'New canvas' }), {
      button: 0,
      ctrlKey: false,
    })
    const item = await screen.findByRole('menuitem', { name: 'New canvas' })
    view.rerender(
      <DocumentListView rows={rows()} onOpen={onOpen} onCreate={onCreate} createDisabled />,
    )
    fireEvent.pointerUp(item)
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('createDisabled disables both create affordances', () => {
    const { onCreate } = renderList({ createDisabled: true })
    const plus = screen.getByRole('button', { name: 'New canvas' })
    expect(plus.hasAttribute('disabled')).toBe(true)
    cleanup()
    const empty = renderList({ rows: [], createDisabled: true })
    const action = screen.getByRole('button', { name: /create a canvas/i })
    expect(action.hasAttribute('disabled')).toBe(true)
    fireEvent.click(action)
    expect(empty.onCreate).not.toHaveBeenCalled()
    expect(onCreate).not.toHaveBeenCalled()
  })

  it('opens a canvas from the wrapper div AND from the nested button', () => {
    const { onOpen } = renderList()
    const card = screen.getAllByTestId('document-list-card')[0]!
    fireEvent.click(card)
    expect(onOpen).toHaveBeenCalledWith('alpha')
    onOpen.mockClear()
    fireEvent.click(within(card).getByRole('button', { name: /alpha/i }))
    expect(onOpen).toHaveBeenCalledWith('alpha')
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('offers both kinds from the + menu, icon-and-label, creating immediately', async () => {
    const { onCreate } = renderList()
    const trigger = screen.getByRole('button', { name: 'New canvas' })
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
    const spatial = await screen.findByRole('menuitem', { name: /new canvas/i })
    const markdown = await screen.findByRole('menuitem', { name: /new markdown note/i })
    expect(spatial.textContent).toMatch(/new canvas/i)
    expect(markdown.textContent).toMatch(/new markdown note/i)
    fireEvent.pointerUp(markdown)
    expect(onCreate).toHaveBeenCalledWith('markdown')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('capability permutation: renderThumb renders per card; omitting it yields label-only cards', () => {
    renderList({
      renderThumb: (row) => <div data-testid={`thumb-${row.path}`} />,
    })
    expect(screen.getByTestId('thumb-notes')).toBeTruthy()
    expect(screen.getByTestId('thumb-alpha')).toBeTruthy()
    cleanup()
    renderList()
    expect(screen.queryByTestId('thumb-notes')).toBeNull()
    expect(screen.getAllByTestId('document-list-card')).toHaveLength(2)
  })

  it('empty rows: a text-labelled create action, calling onCreate(spatial)', () => {
    const { onCreate } = renderList({ rows: [] })
    const action = screen.getByRole('button', { name: /create a canvas/i })
    fireEvent.click(action)
    expect(onCreate).toHaveBeenCalledWith('spatial')
  })

  it('announces a markdown row as text, not color alone', () => {
    renderList()
    const card = screen.getAllByTestId('document-list-card')[1]!
    expect(within(card).getByText(/markdown/i)).toBeTruthy()
  })

  it('renders the caller-supplied secondary line and a relative timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T00:00:30Z'))
    try {
      renderList({
        rows: [
          {
            path: 'alpha',
            displayName: 'Alpha',
            secondary: 'alpha',
            updatedAt: '2026-08-11T00:00:00Z',
            kind: 'spatial',
          },
        ],
      })
      const card = screen.getAllByTestId('document-list-card')[0]!
      expect(within(card).getByTestId('canvas-secondary').textContent).toBe('alpha')
      expect(within(card).getByText('30s ago')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('renders per-card actions whose clicks do not open the canvas', () => {
    const onAction = vi.fn()
    const { onOpen } = renderList({
      renderActions: (row) => (
        <button
          type="button"
          aria-label={`Act on ${row.displayName}`}
          onClick={(e) => {
            e.stopPropagation()
            onAction(row.path)
          }}
        >
          Act
        </button>
      ),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Act on Notes' }))
    expect(onAction).toHaveBeenCalledWith('notes')
    expect(onOpen).not.toHaveBeenCalled()
  })
})

describe('DocumentListView — branded empty state', () => {
  it('shows the faint signature watermark above the empty-state copy', () => {
    render(
      <DocumentListView rows={[]} onCreate={() => {}} onOpen={() => {}} renderThumb={() => null} />,
    )
    expect(document.querySelector('[data-mark="empty-squiggle"]')).toBeTruthy()
    expect(screen.getByText('No canvases yet')).toBeTruthy()
  })
})

describe('DocumentListView empty state — says what this is', () => {
  it('names the product and what a canvas is for, not just its own emptiness', () => {
    renderList({ rows: [] })
    // Someone who arrived from a link has no other page to learn from.
    expect(screen.getByText(/notes.*connect|connect.*notes/i)).toBeTruthy()
    expect(screen.getByText(/stays in this browser|on your (device|machine)/i)).toBeTruthy()
  })
})
