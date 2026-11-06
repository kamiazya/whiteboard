import { cleanup, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import '../../index.css'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import { RecentLane } from './RecentLane.js'

// Real browser: what is under test is what a fine pointer and the keyboard do
// to a tile, and whether its selected mark is actually painted — the tiles
// sit in their own sideways scroller, which clips whatever reaches past it.

afterEach(cleanup)

const documents: WorkspaceDocumentEntry[] = [
  { documentId: 'd1', path: 'login', name: 'Login', kind: 'markdown' },
  { documentId: 'd2', path: 'board', name: 'Board', kind: 'spatial' },
]

function Host({ onOpen }: { onOpen: (entry: WorkspaceDocumentEntry) => void }) {
  const [selected, setSelected] = useState<string | undefined>(undefined)
  return (
    <RecentLane
      documents={documents}
      recentIds={['d2', 'd1']}
      selectedPath={selected}
      onSelect={(entry) => setSelected(entry.path)}
      onOpen={onOpen}
    />
  )
}

describe('a Recent tile on a fine pointer', () => {
  it('selects on a click with its ring unclipped, then Enter opens it', async () => {
    const onOpen = vi.fn()
    render(<Host onOpen={onOpen} />)
    const tile = () => screen.getByRole('button', { name: /Board/ })

    await userEvent.click(tile())
    expect(tile().getAttribute('aria-current')).toBe('true')
    expect(onOpen).not.toHaveBeenCalled()

    // The selected ring is a 1px shadow OUTSIDE the border; the scroller has
    // to leave room for it, or the top and bottom of the mark are cut off.
    const style = getComputedStyle(tile())
    expect(style.boxShadow).not.toBe('none')
    const scroller = tile().parentElement as HTMLElement
    const inner = scroller.getBoundingClientRect()
    const box = tile().getBoundingClientRect()
    expect(box.top - inner.top).toBeGreaterThanOrEqual(1)
    expect(inner.bottom - box.bottom).toBeGreaterThanOrEqual(1)
    expect(box.left - inner.left).toBeGreaterThanOrEqual(1)

    await userEvent.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(documents[1])
  })
})
