import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useDocumentOutline } from './useDocumentOutline.js'

afterEach(cleanup)

function Probe({
  kind,
  body,
  nodes = [],
}: {
  kind: 'markdown' | 'spatial'
  body: string | null
  nodes?: {
    id: string
    type: 'text'
    x: number
    y: number
    width: number
    height: number
    text: string
  }[]
}) {
  const rects = useDocumentOutline({ kind, canvas: { nodes, edges: [] }, markdownBody: body })
  return <div data-testid="count">{rects.length}</div>
}

// The markdown branch needs a real worker and is exercised end to end by
// markdown-editor/rail-write-mode.browser.test.tsx. It is NOT repeated here:
// the pool is a per-context singleton that never disposes, so a second
// browser file spawning its own fleet measurably destabilised the whole
// project — 649/649 clean without it, failures in two consecutive runs with.
describe('useDocumentOutline', () => {
  it('takes a spatial canvas’s own boxes, synchronously', () => {
    const { getByTestId } = render(
      <Probe
        kind="spatial"
        body={null}
        nodes={[
          { id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a' },
          { id: 'b', type: 'text', x: 20, y: 0, width: 10, height: 10, text: 'b' },
        ]}
      />,
    )
    // No await: a spatial outline costs a map, not a layout.
    expect(getByTestId('count').textContent).toBe('2')
  })

  it('lays nothing out for a markdown document with nothing in it', () => {
    const { getByTestId } = render(<Probe kind="markdown" body="   " />)
    expect(getByTestId('count').textContent).toBe('0')
  })

  it('ignores a spatial canvas’s nodes once the document is markdown', () => {
    const { getByTestId } = render(
      <Probe
        kind="markdown"
        body=""
        nodes={[{ id: 'a', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'a' }]}
      />,
    )
    expect(getByTestId('count').textContent).toBe('0')
  })
})
