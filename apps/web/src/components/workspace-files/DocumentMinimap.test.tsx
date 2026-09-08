import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentMinimap } from './DocumentMinimap.js'
import type { RowOutline } from './load-row-outline.js'

afterEach(cleanup)

const doc = { documentId: 'c1', path: 'a/b', name: 'Diagram', kind: 'spatial' as const }
const rects = [
  { x: 0, y: 0, w: 200, h: 120, color: '#909090' },
  { x: 240, y: 0, w: 160, h: 90, color: '#909090' },
]

function installObserver() {
  const instances: { fire: () => void }[] = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        instances.push({ fire: () => cb([{ isIntersecting: true }]) })
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  return instances
}

describe('DocumentMinimap', () => {
  // The whole reason for the visibility gate: a tree lists more rows than
  // fit, and each miniature costs a fetch of that document's bytes.
  it('does not read a document nobody has scrolled to', () => {
    installObserver()
    const loadOutline = vi.fn(async () => ({ rects }))
    render(<DocumentMinimap document={doc} loadOutline={loadOutline} />)
    expect(loadOutline).not.toHaveBeenCalled()
  })

  it('draws the document’s shape once the row is seen', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentMinimap document={doc} loadOutline={async () => ({ rects })} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() =>
      expect(getByTestId('document-minimap').querySelectorAll('span').length).toBe(rects.length),
    )
  })

  // A miniature is a convenience. A document that cannot be read, or has
  // nothing in it, keeps the icon that says what kind it is.
  it('keeps the kind icon when the shape cannot be read', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentMinimap document={doc} loadOutline={async () => null} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() =>
      expect(getByTestId('document-minimap').querySelector('[data-kind]')).not.toBeNull(),
    )
  })

  it('keeps the kind icon when the read fails outright', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentMinimap
        document={doc}
        loadOutline={async () => {
          throw new Error('offline')
        }}
      />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() =>
      expect(getByTestId('document-minimap').querySelector('[data-kind]')).not.toBeNull(),
    )
  })

  it('keeps the kind icon for an empty document rather than an empty box', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentMinimap document={doc} loadOutline={async () => ({ rects: [] })} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() =>
      expect(getByTestId('document-minimap').querySelector('[data-kind]')).not.toBeNull(),
    )
  })

  it('is hidden from assistive technology — the row’s name already says which document it is', () => {
    installObserver()
    const { getByTestId } = render(
      <DocumentMinimap document={doc} loadOutline={async () => ({ rects })} />,
    )
    expect(getByTestId('document-minimap').getAttribute('aria-hidden')).toBe('true')
  })
})

describe('DocumentMinimap with a document symbol', () => {
  it("draws the document's own mark instead of its shape", async () => {
    // A symbol is what a person put there; the miniature is derived. At 24px
    // the derived picture is an arrangement of smudges, so the deliberate
    // mark wins.
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentMinimap
        document={doc}
        loadOutline={async () => ({ rects, symbol: { kind: 'emoji', char: '📌' } })}
      />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() => expect(getByTestId('document-minimap').textContent).toBe('📌'))
    // ...and the shape is not drawn underneath it.
    expect(getByTestId('document-minimap').querySelectorAll('span.absolute').length).toBe(0)
  })

  // A re-read that answers nothing renderable is an ANSWER, not a gap. The
  // effect re-runs whenever the entry object is rebuilt — which the panel
  // does on every refresh — so holding the last good value means a mark that
  // was removed keeps being drawn until something unmounts the row.
  it('stops drawing a mark the document no longer carries', async () => {
    const observers = installObserver()
    let answer: RowOutline | null = { rects, symbol: { kind: 'emoji', char: '📌' } }
    const loadOutline = async () => answer
    const { getByTestId, rerender } = render(
      <DocumentMinimap document={doc} loadOutline={loadOutline} />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() => expect(getByTestId('document-minimap').textContent).toBe('📌'))

    answer = { rects: [] }
    // A fresh entry for the same document, the way a refreshed list hands
    // one over — the row is not remounted, so nothing resets its state.
    rerender(<DocumentMinimap document={{ ...doc }} loadOutline={loadOutline} />)
    await waitFor(() =>
      expect(getByTestId('document-minimap').querySelector('[data-kind]')).not.toBeNull(),
    )
    expect(getByTestId('document-minimap').textContent).toBe('')
  })

  it('falls back to the shape when the icon name is not one this build carries', async () => {
    const observers = installObserver()
    const { getByTestId } = render(
      <DocumentMinimap
        document={doc}
        loadOutline={async () => ({ rects, symbol: { kind: 'icon', name: 'no-such-icon' } })}
      />,
    )
    act(() => observers[0]?.fire())
    await waitFor(() =>
      expect(getByTestId('document-minimap').querySelectorAll('span.absolute').length).toBe(
        rects.length,
      ),
    )
  })
})
