import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import type { CoreSvgAsk } from './canvas-core.js'
import { layoutSpatialEdgesPicture } from './core-picture.js'
import { fakeLayoutCore } from './test-utils/fake-layout-core.js'
import { createFakeMeasure } from './test-utils/fake-measure.js'
import { createSpatialTheme } from './theme/spatial-theme.js'

const keyed = { svg: '<svg></svg>', rootOpen: '<svg>', rootAttrs: {}, groups: [] }

describe('an edge layer pictured through the core', () => {
  it('refuses a keyed answer rather than redrawing the layer here', () => {
    const core = fakeLayoutCore({
      query: { layoutQuery: () => ({ nodes: [], degradations: [], keyed }) },
    })
    // The type refuses a keyed ask; this pins the run-time guard behind it,
    // for a caller that reaches the envelope through a cast.
    const ask = { padding: 0, form: 'keyed' } as CoreSvgAsk as { padding: number }
    const canvas = {
      nodes: [textNode({ id: 'n', x: 0, y: 0, width: 80, height: 40, text: 'a' })],
      edges: [],
    }
    const options = {
      core,
      measure: createFakeMeasure(),
      appearance: createSpatialTheme({ mode: 'light' }),
    }
    expect(() => layoutSpatialEdgesPicture(canvas, options, ask)).toThrow(
      'the core answered a keyed projection, not an SVG',
    )
  })
})
