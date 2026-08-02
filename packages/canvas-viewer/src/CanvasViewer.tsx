import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import {
  layoutSpatialCanvas,
  renderSceneToSvg,
  type SvgDocumentOptions,
} from '@kamiazya/whiteboard-canvas-render'
import { useMemo } from 'react'
import { createBrowserMeasureText } from './measure-text.js'
import { useViewerFontReady } from './use-viewer-font-ready.js'
import { VIEWER_APPEARANCE } from './viewer-appearance.js'

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
  // Stable across re-renders of the same component instance so layoutSpatialCanvas
  // doesn't recreate the (lazily-created) Canvas 2D context on every render.
  const resolvedMeasure = useMemo(() => measure ?? createBrowserMeasureText(), [measure])

  // Kicks off (or joins) the shared viewer-font load and flips true once the
  // real face is loaded — a `mount.ts`-only host (the MCP Apps widget, which
  // registers its own fonts before mounting, or a standalone
  // mountCanvasViewer caller) never goes through apps/web's main.tsx bound
  // wait, so this component is the fallback seam that still eventually
  // re-measures with the real face instead of staying on fallback metrics
  // for its whole lifetime. Included in the svg memo's deps so the SVG is
  // recomputed exactly when readiness ticks, not on every render.
  const fontReady = useViewerFontReady()

  const svg = useMemo(() => {
    const scene = layoutSpatialCanvas(canvas, {
      measure: resolvedMeasure,
      parseBody: parseMarkdownBody,
      appearance: VIEWER_APPEARANCE,
      // No onDegrade: the viewer degrades silently by choice — it has no
      // logger to report through, and a malformed body/unrecognized node
      // still renders (chrome-only or a literal fallback run).
    })
    return renderSceneToSvg(scene, { width, height, padding, background })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fontReady is a
    // pure re-measure trigger, not a value read inside the callback.
  }, [canvas, resolvedMeasure, width, height, padding, background, fontReady])

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
