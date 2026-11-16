// Confirms mcp-server still observes the layout's degradations via the
// injected `onDegrade` callback and its own `getLogger`, even though
// canvas-render itself has no logger to fall back on. A body the core could
// not parse is reported by the core and nothing in this package can make it
// fail, so that case wraps the real core to add the report it would make.

import type { LayoutCore } from '@kamiazya/whiteboard-canvas-render'
import { testLayoutCore } from '@kamiazya/whiteboard-canvas-render/test-utils/node-core'
import type { SpatialCanvas, SpatialNode } from '@kamiazya/whiteboard-model'
import { textNode as buildTextNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { captureLogsForTests } from '../log.js'
import { renderSpatialCanvasToSvg as render } from './headless-renderer.js'
import { NO_INSTALLED_FONTS } from './test-utils/no-installed-fonts.js'

const real = testLayoutCore()

/** The real core, reporting every body it lays out as one it could not parse. */
const parseFailing: LayoutCore = {
  ...real,
  layout: {
    layoutSpatialCanvas: (...args: Parameters<LayoutCore['layout']['layoutSpatialCanvas']>) => {
      const answer = real.layout.layoutSpatialCanvas(...args)
      if ('refused' in answer) return answer
      const failed = args[0].canvas.nodes.map((node) => ({
        kind: 'body-parse-failed' as const,
        nodeId: node.id,
      }))
      return { ...answer, degradations: [...answer.degradations, ...failed] }
    },
  },
}

const renderSpatialCanvasToSvg = (canvas: SpatialCanvas, core: LayoutCore = real) =>
  render(canvas, NO_INSTALLED_FONTS, { core })

function textNode(overrides: Partial<SpatialNode> = {}): SpatialCanvas {
  return {
    nodes: [
      buildTextNode({
        id: 'n1',
        x: 0,
        y: 0,
        width: 100,
        height: 40,
        text: 'a body',
        ...overrides,
      }) as SpatialNode,
    ],
    edges: [],
  }
}

describe('headless-renderer degradation observability', () => {
  it('logs a warning when a text node body fails to parse as markdown', async () => {
    const capture = captureLogsForTests()
    try {
      await renderSpatialCanvasToSvg(textNode(), parseFailing)
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
    // Schema-valid since ADR-0038 decision 3, and reachable through the
    // store: a resource whose media type nothing in `RESOURCE_KINDS` claims.
    // Under the node-kind union this needed a cast, because such a node
    // failed to parse and `readSpatialCanvas` dropped it — the defensive
    // branch had no real caller at all.
    const canvas: SpatialCanvas = {
      nodes: [
        {
          ...(textNode().nodes[0] as SpatialNode),
          resource: { mimeType: 'application/x-nothing-claims-this' },
        },
      ],
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
