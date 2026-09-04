import { cleanup, render, waitFor } from '@testing-library/react'
import { useCallback, useMemo } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentOutlineSource } from '../lib/document-outline.js'
import { DOCUMENT_SYNC_CHANGED_EVENT } from '../lib/document-sync-types.js'
import type { FaviconRect } from '../lib/favicon.js'
import { createInTabRenderBroker } from '../lib/render-broker.js'
import { useDocumentOutline } from './useDocumentOutline.js'

afterEach(cleanup)

const RECTS: readonly FaviconRect[] = [
  { x: 0, y: 0, w: 10, h: 10 },
  { x: 20, y: 0, w: 10, h: 10 },
]

function Probe({
  source,
  outline,
  kind = 'spatial',
  revision = 'r0',
}: {
  source: () => DocumentOutlineSource | null
  outline: (s: DocumentOutlineSource) => Promise<readonly FaviconRect[] | null>
  kind?: 'spatial' | 'markdown'
  revision?: unknown
}) {
  // Stable identities: the hook's effect depends on all three, and a fresh
  // one per render would re-subscribe forever — and a fresh BROKER per render
  // would make every ask a first ask, which is exactly the deduplication
  // these tests are about.
  const broker = useMemo(() => createInTabRenderBroker(), [])
  const readSource = useCallback(() => source(), [source])
  const produce = useCallback((s: DocumentOutlineSource) => outline(s), [outline])
  return (
    <div data-testid="count">
      {
        useDocumentOutline({
          documentId: 'd1',
          kind,
          revision,
          readSource,
          broker,
          outline: produce,
        }).length
      }
    </div>
  )
}

const spatialAt = (frontier: string): DocumentOutlineSource => ({
  frontier,
  snapshot: new Uint8Array([1, 2, 3]),
})

describe('useDocumentOutline', () => {
  it('asks once at mount and shows what comes back', async () => {
    const outline = vi.fn(async () => RECTS)
    const { getByTestId } = render(<Probe source={() => spatialAt('v1')} outline={outline} />)

    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'))
    expect(outline).toHaveBeenCalledTimes(1)
  })

  // The trigger the whole hook is built around. Without it the outline is
  // computed in the render path on every edit, most of them thrown away.
  it('recomputes when the document changes, and not otherwise', async () => {
    let frontier = 'v1'
    const outline = vi.fn(async () => RECTS)
    const source = () => spatialAt(frontier)
    const { getByTestId } = render(<Probe source={source} outline={outline} />)
    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'))

    // A change notification for a document that has NOT moved answers from
    // the memo: same version, same picture, no second render.
    window.dispatchEvent(new CustomEvent(DOCUMENT_SYNC_CHANGED_EVENT))
    await Promise.resolve()
    expect(outline).toHaveBeenCalledTimes(1)

    frontier = 'v2'
    window.dispatchEvent(new CustomEvent(DOCUMENT_SYNC_CHANGED_EVENT))
    await waitFor(() => expect(outline).toHaveBeenCalledTimes(2))
  })

  // The reason the version travels WITH the bytes. A burst of edits inside
  // one worker round trip must not all collapse onto the first one's answer:
  // each has its own version, so each is its own key.
  it('does not answer a later state from an earlier state’s entry', async () => {
    const seen: string[] = []
    let frontier = 'v1'
    const outline = vi.fn(async (s: DocumentOutlineSource) => {
      seen.push(s.frontier)
      return RECTS
    })
    render(<Probe source={() => spatialAt(frontier)} outline={outline} />)
    await waitFor(() => expect(seen).toEqual(['v1']))

    frontier = 'v2'
    window.dispatchEvent(new CustomEvent(DOCUMENT_SYNC_CHANGED_EVENT))
    frontier = 'v3'
    window.dispatchEvent(new CustomEvent(DOCUMENT_SYNC_CHANGED_EVENT))

    await waitFor(() => expect(seen).toEqual(['v1', 'v2', 'v3']))
  })

  // Before the first snapshot there is no version, and a picture filed under
  // "no version" would be served for as long as the tab is open.
  it('asks for nothing while the document has not hydrated', async () => {
    const outline = vi.fn(async () => RECTS)
    const { getByTestId } = render(<Probe source={() => null} outline={outline} />)

    await Promise.resolve()
    expect(outline).not.toHaveBeenCalled()
    expect(getByTestId('count').textContent).toBe('0')
  })

  it('lays nothing out for a markdown document with nothing in it', async () => {
    const outline = vi.fn(async () => RECTS)
    const { getByTestId } = render(
      <Probe kind="markdown" source={() => ({ frontier: 'v1', body: '   ' })} outline={outline} />,
    )

    await Promise.resolve()
    expect(outline).not.toHaveBeenCalled()
    expect(getByTestId('count').textContent).toBe('0')
  })

  // Total by contract: the tab keeps the shape it had rather than throwing.
  it('keeps the last shape when the outline refuses', async () => {
    let answer: readonly FaviconRect[] | null = RECTS
    let frontier = 'v1'
    const outline = vi.fn(async () => answer)
    const { getByTestId } = render(<Probe source={() => spatialAt(frontier)} outline={outline} />)
    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'))

    answer = null
    frontier = 'v2'
    window.dispatchEvent(new CustomEvent(DOCUMENT_SYNC_CHANGED_EVENT))
    await waitFor(() => expect(outline).toHaveBeenCalledTimes(2))
    expect(getByTestId('count').textContent).toBe('2')
  })
  // The other trigger, and the one that matters in the running app: a
  // markdown document typed into in browser mode fires no
  // `whiteboard:doc_changed` at all, so an outline driven by the event alone
  // never updates. Re-rendering with a new published value asks again.
  it('asks again when the page re-renders with a changed document', async () => {
    let frontier = 'v1'
    const outline = vi.fn(async () => RECTS)
    const source = () => spatialAt(frontier)
    const { rerender, getByTestId } = render(
      <Probe source={source} outline={outline} revision="r0" />,
    )
    await waitFor(() => expect(getByTestId('count').textContent).toBe('2'))

    frontier = 'v2'
    rerender(<Probe source={source} outline={outline} revision="r1" />)
    await waitFor(() => expect(outline).toHaveBeenCalledTimes(2))
  })
})
