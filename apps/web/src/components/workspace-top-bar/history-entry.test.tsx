// @vitest-environment jsdom

/**
 * The history entry point belongs to the DOCUMENT, not to the canvas editor.
 *
 * It used to ride the spatial editor's dock (`paletteLeading`), which a
 * markdown document never renders — so a markdown document had no way to
 * reach a history its keeper was already writing. The daemon's auto-version
 * trigger looks at no document kind, so markdown documents on a daemon had
 * been accumulating checkpoints with no surface to list or restore them.
 *
 * These cases pin the entry point to the top bar and keep it kind-agnostic.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../HeaderBranchChip', () => ({
  HeaderBranchChip: () => <div data-testid="header-branch-chip" />,
}))
vi.mock('@/hooks/useDirtyState', () => ({ useDirtyState: () => ({ isDirty: false }) }))
vi.mock('@kamiazya/whiteboard-daemon-client/api-client', () => ({ apiFetch: vi.fn() }))

import { apiFetch } from '@kamiazya/whiteboard-daemon-client/api-client'
import WorkspaceTopBar from '../WorkspaceTopBar'

function renderBar(props: Partial<Parameters<typeof WorkspaceTopBar>[0]> = {}) {
  return render(
    <WorkspaceTopBar
      workspaceId="ws_1"
      path="notes/meeting"
      onNavigateBack={() => {}}
      {...props}
    />,
    { container: document.body },
  )
}

beforeEach(() => {
  vi.mocked(apiFetch).mockImplementation(
    async () =>
      new Response(JSON.stringify({ workspace: 'My WS', documents: {}, pinned: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('the top bar carries the history entry point', () => {
  it('offers History whenever the page passes a toggle, whatever the document holds', () => {
    renderBar({ historyOpen: false, onToggleHistory: () => {} })
    const button = screen.getByRole('button', { name: 'History' })
    // Icon-first, per DESIGN.md's object-action rule.
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })

  it('reports the open panel through aria-expanded, so the control says what it did', () => {
    renderBar({ historyOpen: true, onToggleHistory: () => {} })
    expect(screen.getByRole('button', { name: 'History' }).getAttribute('aria-expanded')).toBe(
      'true',
    )
  })

  it('asks the page to toggle rather than owning the panel — the panel is a body column', () => {
    const onToggleHistory = vi.fn()
    renderBar({ historyOpen: false, onToggleHistory })
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(onToggleHistory).toHaveBeenCalledTimes(1)
  })

  it('hides the control for a document with no history to open', () => {
    renderBar({ historyOpen: false })
    expect(screen.queryByRole('button', { name: 'History' })).toBeNull()
  })
})
