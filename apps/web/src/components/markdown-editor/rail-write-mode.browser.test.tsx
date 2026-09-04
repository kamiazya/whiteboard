import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { useCallback, useMemo } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDocumentOutline } from '../../hooks/useDocumentOutline.js'
import { useMarkdownOutline } from '../../hooks/useMarkdownOutline.js'
import { createInTabRenderBroker } from '../../lib/render-broker.js'
import { MarkdownEditor } from './MarkdownEditor.js'

const SHORT = '# One\n\nJust a line.\n'
const LONG =
  SHORT + Array.from({ length: 14 }, (_, i) => `\n## Section ${i}\n\nSome prose here.\n`).join('')
// Both documents below must actually SCROLL their pane: the rail doubles as
// the scrollbar and is hidden when there is nothing to scroll, so a document
// that fits draws no bars to count.
const LONGER =
  LONG + Array.from({ length: 14 }, (_, i) => `\n## Later ${i}\n\nMore prose here.\n`).join('')

// Write mode renders no preview, so nothing on the main thread lays the
// document out — this is the path where a real worker does it. The fakes in
// layout-worker-pool.test.ts cannot reach it: a dispatch that only breaks
// under real postMessage ordering is exactly what stranded this once.
describe('the rail in write mode', () => {
  afterEach(() => {
    window.localStorage.removeItem('whiteboard.markdown-view-mode')
    cleanup()
  })

  it('lays the document out through the worker pool, with no preview mounted', async () => {
    const { container, rerender } = render(
      <div style={{ width: '900px', height: '400px' }}>
        <MarkdownEditor
          initialViewMode="write"
          value={LONG}
          onChange={() => undefined}
          className="h-full"
        />
      </div>,
    )
    const bars = () =>
      container.querySelectorAll('[data-testid="markdown-minimap-rail"] > div').length

    await waitFor(() => expect(bars()).toBeGreaterThan(1), { timeout: 15_000 })
    // The condition this test exists for: no preview ever rendered, so the
    // bars cannot have come from one.
    expect(container.querySelector('[data-testid="markdown-preview-scroll"]')).toBeNull()
    const fewer = bars()

    rerender(
      <div style={{ width: '900px', height: '400px' }}>
        <MarkdownEditor
          initialViewMode="write"
          value={LONGER}
          onChange={() => undefined}
          className="h-full"
        />
      </div>,
    )

    await waitFor(() => expect(bars()).toBeGreaterThan(fewer), { timeout: 15_000 })
  })

  // The rail replaces the scrollbar, so pressing it has to MOVE something.
  // Every test until now checked the bars it draws and none checked the one
  // thing it is for.
  it('scrolls the source to the position pressed', async () => {
    const { container } = render(
      <div style={{ width: '900px', height: '300px' }}>
        <MarkdownEditor
          initialViewMode="write"
          value={LONG}
          onChange={() => undefined}
          className="h-full"
        />
      </div>,
    )
    const rail = await waitFor(
      () => {
        const el = container.querySelector('[data-testid="markdown-minimap-rail"]')
        if (el === null) throw new Error('no rail yet')
        if (el.querySelectorAll(':scope > div').length < 5) throw new Error('no bars yet')
        return el as HTMLElement
      },
      { timeout: 15_000 },
    )
    const scroller = container.querySelector('.cm-scroller') as HTMLElement
    expect(scroller.scrollTop).toBe(0)

    const box = rail.getBoundingClientRect()
    rail.setPointerCapture = () => undefined
    rail.hasPointerCapture = () => true
    fireEvent.pointerDown(rail, { clientY: box.top + box.height * 0.85, pointerId: 1 })

    // Pressing near the bottom of the map lands near the end of the document.
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0), { timeout: 5_000 })
  })
})

// Folded in here rather than given its own file: the pool is a per-context
// singleton that never disposes, so every extra browser file that touches it
// starts another fleet of workers — measurably enough to destabilise the
// whole project.
function OutlineProbe({ body }: { body: string }) {
  const broker = useMemo(() => createInTabRenderBroker(), [])
  // A version that moves with the text, which is what the real source's
  // frontier does — without one the memo would answer the second body from
  // the first body's entry, which is the case these tests are about.
  const readSource = useCallback(() => ({ frontier: `len-${body.length}`, body }), [body])
  const rects = useDocumentOutline({
    documentId: 'outline-probe',
    kind: 'markdown',
    readSource,
    broker,
  })
  return <div data-testid="outline-count">{rects.length}</div>
}

function KeyedProbe({ body }: { body: string }) {
  const outline = useMarkdownOutline(body, { enabled: true, maxWidth: 400 })
  return (
    <div data-testid="keyed">
      {outline.forBody === body ? `current:${outline.blocks.length}` : 'stale'}
    </div>
  )
}

// The hook holds its last shape across a disable and a refusal so the rail
// does not blink, which means a consumer can be handed the shape of text
// that is no longer on screen. `forBody` is how it says which text it
// describes — the editor refuses to publish one that does not match, and a
// timing test of that window would assert nothing, since the worker answers
// either way. This pins the contract that guard depends on.
afterEach(cleanup)

describe('an outline says which text it describes', () => {
  it('carries the body it was computed for', async () => {
    const { getByTestId, rerender } = render(<KeyedProbe body={'# One\n\nProse.\n'} />)
    await waitFor(() => expect(getByTestId('keyed').textContent).toMatch(/^current:[1-9]/), {
      timeout: 15_000,
    })

    rerender(<KeyedProbe body={'# Two\n\nDifferent prose entirely.\n\n## More\n'} />)
    await waitFor(() => expect(getByTestId('keyed').textContent).toMatch(/^current:[1-9]/), {
      timeout: 15_000,
    })
  })
})

describe('a markdown document’s outline', () => {
  // Retaining the last shape across a disable is what stops the rail
  // blinking mid-edit. Retaining it across a CLEAR would draw a document
  // that is no longer there.
  it('is forgotten when the document is emptied', async () => {
    const { getByTestId, rerender } = render(<OutlineProbe body={'# Title\n\nProse.\n'} />)
    await waitFor(() => expect(getByTestId('outline-count').textContent).not.toBe('0'), {
      timeout: 15_000,
    })

    rerender(<OutlineProbe body="" />)
    await waitFor(() => expect(getByTestId('outline-count').textContent).toBe('0'))
  })

  it('has a shape at all, which only a layout can give it', async () => {
    const { getByTestId } = render(<OutlineProbe body={'# Title\n\nSome prose.\n\n## Next\n'} />)
    await waitFor(() => expect(getByTestId('outline-count').textContent).not.toBe('0'), {
      timeout: 15_000,
    })
  })
})
