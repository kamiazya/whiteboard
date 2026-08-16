import { parseMarkdownBody } from '@kamiazya/whiteboard-canvas-codec'
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { MdastRoot } from '@kamiazya/whiteboard-canvas-model/mdast'
import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import {
  createSpatialTheme,
  layoutSpatialCanvas,
  renderSceneToSvg,
  type SvgDocumentOptions,
} from '@kamiazya/whiteboard-canvas-render'
import { useMemo } from 'react'
import { createBrowserMeasureText } from './measure-text.js'
import { useViewerFontReady } from './use-viewer-font-ready.js'

// This viewer is read-only and has no theme switch of its own, so it always
// renders through canvas-render's shared light theme
// (`@kamiazya/whiteboard-canvas-render`'s `createSpatialTheme`) — see
// package-canvas-render.md decision #8.
const VIEWER_APPEARANCE = createSpatialTheme({ mode: 'light' })

export interface CanvasViewerProps {
  canvas: SpatialCanvas
  width?: SvgDocumentOptions['width']
  height?: SvgDocumentOptions['height']
  padding?: SvgDocumentOptions['padding']
  background?: SvgDocumentOptions['background']
  /** Injection seam for tests; defaults to the real Canvas 2D measurer. */
  measure?: MeasureText
  /**
   * A file node's reference resolved to a readable name, and to a
   * referenced MARKDOWN document's already-parsed body.
   *
   * Synchronous by canvas-render's contract, which is why this package
   * takes them as data rather than fetching: it is read-only and has no
   * store. The host supplies them — the MCP Apps widget from
   * `canvas_view`'s `references` payload, since the server is the only side
   * that can read another document. Absent keeps the plain reference card.
   */
  resolveFileLabel?: (file: string) => string | undefined
  resolveFileMarkdown?: (file: string) => MdastRoot | undefined
  testId?: string
  /**
   * Accessible name for the rendered canvas. The viewer cannot derive one:
   * a document's name lives in the workspace, never in canvas content (see
   * vocabulary.md), so the host supplies it and `DEFAULT_LABEL` is only the
   * floor.
   */
  label?: string
}

const DEFAULT_TEST_ID = 'canvas-viewer'
const DEFAULT_LABEL = 'Canvas'

export function CanvasViewer({
  canvas,
  width,
  height,
  padding,
  background,
  measure,
  resolveFileLabel,
  resolveFileMarkdown,
  testId = DEFAULT_TEST_ID,
  label = DEFAULT_LABEL,
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
      ...(resolveFileLabel === undefined ? {} : { resolveFileLabel }),
      ...(resolveFileMarkdown === undefined ? {} : { resolveFileMarkdown }),
      // No onDegrade: the viewer degrades silently by choice — it has no
      // logger to report through, and a malformed body/unrecognized node
      // still renders (chrome-only or a literal fallback run).
    })
    return renderSceneToSvg(scene, { width, height, padding, background })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fontReady is a
    // pure re-measure trigger, not a value read inside the callback.
  }, [
    canvas,
    resolvedMeasure,
    width,
    height,
    padding,
    background,
    resolveFileLabel,
    resolveFileMarkdown,
    fontReady,
  ])

  // Injecting canvas-render's SVG string via dangerouslySetInnerHTML is sound
  // BECAUSE canvas-render's serializer (packages/canvas-render/src/svg/format.ts)
  // is the SOLE producer of this string and escapes `&`/`<`/`>` in text content
  // plus `"`/`'` in attribute values — there is no untrusted-HTML injection
  // path here, and this is not a generic sanitizer-needed sink. Do not add a
  // sanitizer dependency; if this ever stops being canvas-render's own output,
  // this reasoning no longer holds and must be revisited.
  // `figure`, not `img`: the injected SVG's `<text>` runs are real content
  // and today the ONLY way a screen reader reaches any of it, and `img`
  // marks every child presentational — that would buy a name at the cost of
  // the content. A figure names the region and leaves its children
  // reachable. Reading it is still choppy (one run per wrapped line, in
  // document order), which is what the deferred a11y projection is for; a
  // name and reachable text is the honest floor until then.
  return (
    <figure
      data-testid={testId}
      aria-label={label}
      // A real <figure>, not role="figure" on a div: same semantics, and the
      // element carries them without ARIA. Its UA margin is cleared because
      // this is a layout container the host sizes, not prose.
      style={{
        width: width ?? '100%',
        height: height ?? '100%',
        overflow: 'hidden',
        margin: 0,
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
