// The doc scenes' canvas, drawn the way CanvasViewer draws it minus the
// legend. A diagram's boxes carry their own labels, and these scenes spend
// colour on a board that declares no scoped tag, so the real pipeline would
// append a "box colour: no key carries it" diagnostic to every figure.
// Inventing tags purely to quiet that line would put made-up data into a
// scene, so the figure is drawn without the legend instead — the same
// `legend: 'omit'` the editor passes when it draws the legend itself.
//
// Everything else CanvasViewer passes on this path is the default here too
// (the light appearance, the bundled face, the clean style), so a scene
// differs from the viewer's output by that one element.

import {
  createSpatialTheme,
  layoutSpatialCanvas,
  renderSceneToSvg,
} from '@kamiazya/whiteboard-canvas-render'
import { createBrowserMeasureText, SceneSvg } from '@kamiazya/whiteboard-canvas-viewer'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { useMemo } from 'react'

const LIGHT = createSpatialTheme({ mode: 'light' })

interface LegendlessCanvasProps {
  canvas: SpatialCanvas
  width: number
  height: number
  padding?: number
  testId?: string
}

export function LegendlessCanvas({
  canvas,
  width,
  height,
  padding = 0,
  testId,
}: Readonly<LegendlessCanvasProps>) {
  const measure = useMemo(() => createBrowserMeasureText(), [])
  const svg = useMemo(
    () =>
      renderSceneToSvg(layoutSpatialCanvas(canvas, { measure, appearance: LIGHT }), {
        width,
        height,
        padding,
        background: '#ffffff',
        legend: 'omit',
      }),
    [canvas, measure, width, height, padding],
  )
  return (
    <SceneSvg
      as="figure"
      svg={svg}
      data-testid={testId}
      aria-label="Canvas"
      style={{ width, height, overflow: 'hidden', margin: 0 }}
    />
  )
}
