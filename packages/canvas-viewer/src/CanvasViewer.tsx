import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { renderSceneToSvg, type SvgDocumentOptions } from '@kamiazya/whiteboard-canvas-render'
import { useMemo } from 'react'
import { createBrowserMeasureText } from './measure-text.js'
import { buildViewerScene } from './spatial-scene.js'

export interface CanvasViewerProps {
  canvas: SpatialCanvas
  width?: SvgDocumentOptions['width']
  height?: SvgDocumentOptions['height']
  padding?: SvgDocumentOptions['padding']
  background?: SvgDocumentOptions['background']
  /** Injection seam for tests; defaults to the real Canvas 2D measurer. */
  measure?: MeasureText
  testId?: string
}

const DEFAULT_TEST_ID = 'canvas-viewer'

export function CanvasViewer({
  canvas,
  width,
  height,
  padding,
  background,
  measure,
  testId = DEFAULT_TEST_ID,
}: CanvasViewerProps) {
  // Stable across re-renders of the same component instance so buildViewerScene
  // doesn't recreate the (lazily-created) Canvas 2D context on every render.
  const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])

  const svg = useMemo(() => {
    const scene = buildViewerScene(canvas, resolvedMeasure)
    return renderSceneToSvg(scene, { width, height, padding, background })
  }, [canvas, resolvedMeasure, width, height, padding, background])

  // Injecting canvas-render's SVG string via dangerouslySetInnerHTML is sound
  // BECAUSE canvas-render's serializer (packages/canvas-render/src/svg/format.ts)
  // is the SOLE producer of this string and escapes `&`/`<`/`>` in text content
  // plus `"`/`'` in attribute values — there is no untrusted-HTML injection
  // path here, and this is not a generic sanitizer-needed sink. Do not add a
  // sanitizer dependency; if this ever stops being canvas-render's own output,
  // this reasoning no longer holds and must be revisited.
  return (
    <div
      data-testid={testId}
      style={{ width: width ?? '100%', height: height ?? '100%', overflow: 'hidden' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
