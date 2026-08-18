import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useDocumentOutline } from '../../hooks/useDocumentOutline.js'
import { MarkdownEditor } from './MarkdownEditor.js'

const SHORT = '# One\n\nJust a line.\n'
const LONG =
  SHORT + Array.from({ length: 14 }, (_, i) => `\n## Section ${i}\n\nSome prose here.\n`).join('')

// Write mode renders no preview, so nothing on the main thread lays the
// document out — this is the path where a real worker does it. The fakes in
// layout-worker-pool.test.ts cannot reach it: a dispatch that only breaks
// under real postMessage ordering is exactly what stranded this once.
describe('the rail in write mode', () => {
  beforeEach(() => window.localStorage.setItem('whiteboard.markdown-view-mode', 'write'))
  afterEach(() => window.localStorage.clear())

  it('lays the document out through the worker pool, with no preview mounted', async () => {
    const { container, rerender } = render(
      <div style={{ width: '900px', height: '400px' }}>
        <MarkdownEditor value={SHORT} onChange={() => undefined} className="h-full" />
      </div>,
    )
    const bars = () =>
      container.querySelectorAll('[data-testid="markdown-minimap-rail"] > div').length

    await waitFor(() => expect(bars()).toBeGreaterThan(1), { timeout: 15_000 })
    // The condition this test exists for: no preview ever rendered, so the
    // bars cannot have come from one.
    expect(container.querySelector('[data-testid="markdown-preview-scroll"]')).toBeNull()
    const short = bars()

    rerender(
      <div style={{ width: '900px', height: '400px' }}>
        <MarkdownEditor value={LONG} onChange={() => undefined} className="h-full" />
      </div>,
    )

    await waitFor(() => expect(bars()).toBeGreaterThan(short), { timeout: 15_000 })
  })
})

// Folded in here rather than given its own file: the pool is a per-context
// singleton that never disposes, so every extra browser file that touches it
// starts another fleet of workers — measurably enough to destabilise the
// whole project.
function OutlineProbe({ body }: { body: string }) {
  const rects = useDocumentOutline({
    kind: 'markdown',
    canvas: { nodes: [], edges: [] },
    markdownBody: body,
  })
  return <div data-testid="outline-count">{rects.length}</div>
}

describe('a markdown document’s outline', () => {
  it('has a shape at all, which only a layout can give it', async () => {
    const { getByTestId } = render(<OutlineProbe body={'# Title\n\nSome prose.\n\n## Next\n'} />)
    await waitFor(() => expect(getByTestId('outline-count').textContent).not.toBe('0'), {
      timeout: 15_000,
    })
  })
})
