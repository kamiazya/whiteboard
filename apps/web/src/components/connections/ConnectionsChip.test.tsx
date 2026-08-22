import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ConnectionsChip } from './ConnectionsChip.js'

const TWO = [
  {
    documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    path: 'notes',
    name: 'Sprint notes',
    kind: 'markdown' as const,
    contexts: ['…QA完了後に [[Release plan]] の日程を確定する…'],
  },
  {
    documentId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
    path: 'board',
    kind: 'spatial' as const,
    contexts: ['embedded on this canvas'],
  },
]

describe('ConnectionsChip', () => {
  it('shows the backlink count and opens the panel with sources and contexts', () => {
    render(<ConnectionsChip backlinks={TWO} onOpen={() => {}} />)
    const chip = screen.getByRole('button', { name: /connections/i })
    expect(chip.textContent).toContain('2')
    expect(screen.queryByRole('region', { name: /connections/i })).toBeNull()

    fireEvent.click(chip)
    const panel = screen.getByRole('region', { name: /connections/i })
    expect(panel.textContent).toContain('Sprint notes')
    // The unnamed source falls back to its path.
    expect(panel.textContent).toContain('board')
    expect(panel.textContent).toContain('日程を確定する')
  })

  it('navigates to the source document when its row is clicked', () => {
    const onOpen = vi.fn()
    render(<ConnectionsChip backlinks={TWO} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /connections/i }))
    fireEvent.click(screen.getByRole('button', { name: /sprint notes/i }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'notes' }))
  })

  it('renders a zero count rather than hiding — the empty state is the invitation', () => {
    render(<ConnectionsChip backlinks={[]} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: /connections/i }).textContent).toContain('0')
  })

  it('stays quiet while backlinks are not loaded yet', () => {
    render(<ConnectionsChip backlinks={null} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: /connections/i }).hasAttribute('disabled')).toBe(true)
  })
})
