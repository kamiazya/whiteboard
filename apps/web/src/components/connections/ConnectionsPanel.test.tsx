import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { InspectorSegment } from '../document-editor/InspectorSegment.js'
import {
  type ConnectionsBacklink,
  ConnectionsPanel,
  type ConnectionsPanelProps,
} from './ConnectionsPanel.js'

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

/**
 * The opener and the panel the way the document page composes them: the
 * page holds the inspector slot, the segment asks for it, the panel shows
 * in it. The opener alone opens nothing — that is the point of the split.
 *
 * The opener used to be this module's own `ConnectionsChip`, which is why
 * the file was named for it. It is one member of `InspectorSegment` now,
 * beside the other three ways of looking at a document; what stays here is
 * the panel, and the composition below is the pair as the page builds it.
 */
function Connections({
  backlinks,
  ...panel
}: Omit<ConnectionsPanelProps, 'backlinks'> & {
  readonly backlinks: readonly ConnectionsBacklink[] | null
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <InspectorSegment
        open={open ? 'connections' : null}
        onToggle={() => setOpen((o) => !o)}
        tabs={{ connections: { count: backlinks?.length ?? null } }}
      />
      {open && backlinks !== null && <ConnectionsPanel backlinks={backlinks} {...panel} />}
    </>
  )
}

describe('the connections opener', () => {
  it('shows the backlink count and opens the panel with sources and contexts', () => {
    render(<Connections backlinks={TWO} onOpen={() => {}} />)
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

  it('shows unlinked mentions as their own section, and navigates on click', () => {
    const onOpen = vi.fn()
    render(
      <Connections
        backlinks={TWO}
        mentions={[
          {
            documentId: '01CX5ZZKBKACTAV9WEVGEMMVRA',
            path: 'standup',
            name: 'Standup memo',
            kind: 'markdown' as const,
            contexts: ['…昨日の議論で Release plan の前提が変わった…'],
          },
        ]}
        onOpen={onOpen}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /connections/i }))
    const panel = screen.getByRole('region', { name: /connections/i })
    expect(panel.textContent).toContain('Mentioned, not linked')
    expect(panel.textContent).toContain('Standup memo')
    fireEvent.click(screen.getByRole('button', { name: /standup memo/i }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'standup' }))
  })

  it('mention rows offer Link it when a handler is given, and only then', () => {
    const onLinkify = vi.fn()
    const mention = {
      documentId: '01CX5ZZKBKACTAV9WEVGEMMVRA',
      path: 'standup',
      name: 'Standup memo',
      kind: 'markdown' as const,
      contexts: ['…Release plan の前提が…'],
    }
    const { unmount } = render(
      <Connections backlinks={TWO} mentions={[mention]} onOpen={() => {}} onLinkify={onLinkify} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /connections/i }))
    fireEvent.click(screen.getByRole('button', { name: /link it/i }))
    expect(onLinkify).toHaveBeenCalledWith(expect.objectContaining({ path: 'standup' }))
    unmount()

    render(<Connections backlinks={TWO} mentions={[mention]} onOpen={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /connections/i }))
    expect(screen.queryByRole('button', { name: /link it/i })).toBeNull()
  })

  it('hides the mentions section when there are none', () => {
    render(<Connections backlinks={TWO} mentions={[]} onOpen={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /connections/i }))
    expect(screen.getByRole('region', { name: /connections/i }).textContent).not.toContain(
      'Mentioned, not linked',
    )
  })

  it('navigates to the source document when its row is clicked', () => {
    const onOpen = vi.fn()
    render(<Connections backlinks={TWO} onOpen={onOpen} />)
    fireEvent.click(screen.getByRole('button', { name: /connections/i }))
    fireEvent.click(screen.getByRole('button', { name: /sprint notes/i }))
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ path: 'notes' }))
  })

  it('renders a zero count rather than hiding — the empty state is the invitation', () => {
    render(<Connections backlinks={[]} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: /connections/i }).textContent).toContain('0')
  })

  it('stays quiet while backlinks are not loaded yet', () => {
    render(<Connections backlinks={null} onOpen={() => {}} />)
    expect(screen.getByRole('button', { name: /connections/i }).hasAttribute('disabled')).toBe(true)
  })
})
