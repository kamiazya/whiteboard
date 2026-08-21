// Pixel-level regression harness for the shape classes a byte-level SVG-
// string golden cannot protect (see determinism.test.ts / golden-scene.ts
// for that guarantee): a sweep-flag or coordinate-sign bug still produces
// well-formed, merely byte-DIFFERENT XML, so a string-equality golden only
// catches it by accident. `toMatchScreenshot` pins the actual painted
// pixels instead. Fixtures and the deliberate-regeneration flow live in
// ../test-utils/pixel-golden-scenes.ts.

import { afterEach, describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import type { Scene } from '../scene-graph.js'
import {
  buildArrowheadsScene,
  buildJumpHopScene,
  buildNodeOutlinesScene,
  buildRoundedCornersScene,
  buildRoundedRectScene,
} from '../test-utils/pixel-golden-scenes.js'
import { renderSceneToSvg } from './backend.js'

// Fixed integer padding + a solid background keep every baseline's canvas
// deterministic across runs and across the four scenes.
const ENVELOPE_PADDING_PX = 8
const ENVELOPE_BACKGROUND = '#ffffff'

/**
 * Renders `scene` to SVG and mounts the resulting `<svg>` as the page's
 * only content, tagged for `page.getByTestId`. The `<svg>`'s own `width`/
 * `height` attributes (derived from the scene's integer bounds) size the
 * element, so the locator's screenshot is cropped tightly to the drawn
 * content rather than the full fixed viewport.
 */
function mountScene(scene: Scene, testId: string): void {
  const markup = renderSceneToSvg(scene, {
    padding: ENVELOPE_PADDING_PX,
    background: ENVELOPE_BACKGROUND,
  })
  const container = document.createElement('div')
  container.innerHTML = markup
  const svg = container.firstElementChild
  if (svg === null) throw new Error('renderSceneToSvg produced no root element')
  svg.setAttribute('data-testid', testId)
  document.body.append(svg)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('pixel-level golden regression (real browser)', () => {
  it('jump-hop: the later edge hops over the earlier, bulging to the drawn side', async () => {
    mountScene(buildJumpHopScene(), 'jump-hop')
    await expect.element(page.getByTestId('jump-hop')).toMatchScreenshot('jump-hop')
  })

  it('rounded-corners: a bent edge draws its interior vertex as a Q-curve', async () => {
    mountScene(buildRoundedCornersScene(), 'rounded-corners')
    await expect.element(page.getByTestId('rounded-corners')).toMatchScreenshot('rounded-corners')
  })

  it('arrowheads: triangle orientation at each end (left/right/up/down)', async () => {
    mountScene(buildArrowheadsScene(), 'arrowheads')
    await expect.element(page.getByTestId('arrowheads')).toMatchScreenshot('arrowheads')
  })

  it('rect-radius: a shape node with a corner radius renders rx', async () => {
    mountScene(buildRoundedRectScene(), 'rect-radius')
    await expect.element(page.getByTestId('rect-radius')).toMatchScreenshot('rect-radius')
  })

  it('node-outlines: the five non-rect silhouettes, cylinder arcs included', async () => {
    mountScene(buildNodeOutlinesScene(), 'node-outlines')
    await expect.element(page.getByTestId('node-outlines')).toMatchScreenshot('node-outlines')
  })
})
