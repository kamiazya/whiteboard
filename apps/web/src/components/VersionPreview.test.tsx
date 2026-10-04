import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import type { TagLibrary } from '@kamiazya/whiteboard-plugin-visual'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PastDocument } from '../lib/versions-backend.js'
import { VersionPreview } from './VersionPreview.js'

afterEach(cleanup)

// What the preview must draw a past board in, when the workspace's library
// colours its tags: the board and its exports already do.
const LIBRARY: TagLibrary = {
  health: { values: { ok: { color: '4' }, failing: { color: '1' } } },
}

const past: PastDocument = {
  kind: 'spatial',
  canvas: {
    nodes: [
      textNode({ id: 'a', x: 0, y: 0, width: 200, height: 100, text: 'api', tags: ['health:ok'] }),
      textNode({
        id: 'b',
        x: 300,
        y: 0,
        width: 200,
        height: 100,
        text: 'db',
        tags: ['health:failing'],
      }),
    ],
    edges: [],
  },
}

const svgOf = (container: HTMLElement): string =>
  container.querySelector('[data-testid="canvas-viewer"] svg')?.outerHTML ?? ''

describe('VersionPreview and the workspace tag library', () => {
  it('draws a past board by intent, with its legend, when given the library', () => {
    const { container } = render(<VersionPreview past={past} tags={{ library: LIBRARY }} />)
    const svg = svgOf(container)
    expect(svg).toContain('data-wb-legend')
    expect(svg).toContain('#059669')
    expect(svg).toContain('#dc2626')
  })

  it('draws the same board uncoloured, with no legend, without one', () => {
    const { container } = render(<VersionPreview past={past} />)
    const svg = svgOf(container)
    expect(svg).toContain('<svg')
    expect(svg).not.toContain('data-wb-legend')
    expect(svg).not.toContain('#059669')
  })
})
