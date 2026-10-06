/**
 * A fenced block is coloured by DEFAULT. `layoutSpatialCanvas` supplies this
 * package's own tokeniser the way it supplies codec's markdown parser, so a
 * caller that passes no `highlightCode` still draws keywords, strings and
 * comments in the syntax palette — and the SVG backend paints the runs that
 * carry those colours rather than the fence's flat source.
 *
 * Asked here, in the package that owns the default, because every other
 * caller either injects its own highlighter or sits in another package.
 */

import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { expect, it } from 'vitest'
import { renderSceneToSvg } from '../svg/backend.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { SPATIAL_LIGHT_PALETTE } from '../theme/spatial-palette.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import { layoutSpatialCanvas } from './spatial-canvas.js'

const CANVAS: SpatialCanvas = {
  nodes: [
    textNode({
      id: 'n1',
      x: 0,
      y: 0,
      width: 360,
      height: 220,
      text: '```ts\n// note\nexport const x = "hi"\n```',
    }),
  ],
  edges: [],
}

it('colours a fenced block when the caller passes no highlighter', () => {
  const scene = layoutSpatialCanvas(CANVAS, {
    measure: createFakeMeasure(),
    appearance: createSpatialTheme({ mode: 'light' }),
  })
  const svg = renderSceneToSvg(scene)
  const { syntax } = SPATIAL_LIGHT_PALETTE
  expect(svg).toContain(syntax.keyword)
  expect(svg).toContain(syntax.string)
  expect(svg).toContain(syntax.comment)
})
