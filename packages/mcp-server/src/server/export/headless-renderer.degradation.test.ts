// Confirms mcp-server still observes canvas-render's `layoutSpatialCanvas`
// degradations via the injected `onDegrade` callback and its own
// `getLogger`, even though canvas-render itself has no logger to fall back
// on. Only `parseMarkdownBody('__THROW__')` is mocked to throw; every other
// input goes through the real parser, isolating this totality behavior from
// having to find a markdown string that reliably falls outside canvas-codec's
// own versioned mdast subset.
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-canvas-model'
import { describe, expect, it, vi } from 'vitest'

import { captureLogsForTests } from '../log.js'

vi.mock('@kamiazya/whiteboard-canvas-codec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kamiazya/whiteboard-canvas-codec')>()
  return {
    ...actual,
    parseMarkdownBody: (body: string) => {
      if (body === '__THROW__') throw new Error('simulated unsupported mdast construct')
      return actual.parseMarkdownBody(body)
    },
  }
})

const { renderSpatialCanvasToSvg } = await import('./headless-renderer.js')

function textNode(overrides: Partial<SpatialNode> = {}): SpatialCanvas {
  return {
    nodes: [
      {
        id: 'n1',
        type: 'text',
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        text: '__THROW__',
        ...overrides,
      } as SpatialNode,
    ],
    edges: [],
  }
}

describe('headless-renderer degradation observability', () => {
  it('logs a warning when a text node body fails to parse as markdown', async () => {
    const capture = captureLogsForTests()
    try {
      await renderSpatialCanvasToSvg(textNode())
      expect(
        capture.records.some(
          (r) => r.level === 'warning' && r.msg.includes('failed to parse as markdown'),
        ),
      ).toBe(true)
    } finally {
      capture.restore()
    }
  })

  it('logs a warning for an unrecognized spatial node kind', async () => {
    const canvas: SpatialCanvas = {
      nodes: [{ ...textNode().nodes[0], type: 'bogus', text: 'fine' } as unknown as SpatialNode],
      edges: [],
    }
    const capture = captureLogsForTests()
    try {
      await renderSpatialCanvasToSvg(canvas)
      expect(
        capture.records.some(
          (r) => r.level === 'warning' && r.msg.includes('unrecognized spatial node kind'),
        ),
      ).toBe(true)
    } finally {
      capture.restore()
    }
  })
})
