import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { CanvasViewer, createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { type JSX, useMemo } from 'react'
import { editorTextFill } from '../lib/spatial/editor-appearance.js'
import { viewportTransformCss } from '../lib/spatial/viewport.js'
import type { ResolvedTheme } from '../lib/theme.js'
import type { PastDocument } from '../lib/versions-backend.js'
import { PreviewPane } from './markdown-editor/PreviewPane.js'
import { PREVIEW_CONTROL_PROPS, usePreviewViewport } from './use-preview-viewport.js'

/**
 * A past state of a document, drawn read-only.
 *
 * Read-only by CONSTRUCTION rather than by a flag: this is the same
 * `CanvasViewer` the MCP Apps widget uses and the same `PreviewPane` the
 * markdown editor's Read mode uses, neither of which has an edit path to
 * disable. That mattered for the decision — "look at it, then decide" needed
 * a surface where looking cannot become editing, and inventing a read-only
 * mode inside two live editors would have been a far larger change with a
 * far weaker guarantee.
 *
 * The consequence a reader should know: this draws the SAME pipeline the
 * editor draws through, so what you see is what the version holds — but it
 * is not the editor, so nothing here selects or types. It DOES pan and zoom:
 * a whole canvas fitted to a phone is a picture of a document rather than
 * something anyone can read, and "look, then decide" is not a decision
 * anybody can take on a picture they cannot get closer to.
 */
export function DocumentPreview({
  past,
  theme = 'light',
  maxWidth = 720,
}: {
  readonly past: PastDocument
  readonly theme?: ResolvedTheme
  readonly maxWidth?: number
}): JSX.Element {
  const measure = useMemo(() => createBrowserMeasureText(), [])
  if (past.kind === 'markdown') {
    return (
      <div data-testid="document-preview" className="h-full min-h-0 overflow-auto">
        <PreviewPane value={past.body} maxWidth={maxWidth} measure={measure} theme={theme} />
      </div>
    )
  }
  return <PastCanvasPreview canvas={past.canvas} theme={theme} measure={measure} />
}

/**
 * Its own component because the viewport is state, and a hook cannot live
 * behind the kind branch above.
 */
function PastCanvasPreview({
  canvas,
  theme,
  measure,
}: {
  readonly canvas: SpatialCanvas
  readonly theme: ResolvedTheme
  readonly measure: MeasureText
}): JSX.Element {
  const { viewport, moved, reset, rootRef, surfaceHandlers } = usePreviewViewport()
  return (
    <div
      ref={rootRef}
      data-testid="document-preview"
      // `touch-none`: every touch here is a pan or a pinch, and letting the
      // browser also scroll the page under it makes both unusable on a phone
      // — which is the screen this surface is most often read on.
      className="relative h-full min-h-0 touch-none overflow-hidden"
      {...surfaceHandlers}
    >
      <div
        data-testid="preview-viewport"
        style={{
          position: 'absolute',
          inset: 0,
          transform: viewportTransformCss(viewport),
          transformOrigin: '0 0',
          // canvas-render assigns markdown body runs no `fill` at all, so
          // they inherit one from whichever ancestor sets it — the same seam
          // the editor uses to keep body text visible on a dark canvas. The
          // node chrome around them carries its own fill from the theme
          // below and is unaffected.
          fill: editorTextFill(theme),
        }}
      >
        <CanvasViewer
          canvas={canvas}
          measure={measure}
          theme={theme}
          label="A past state of this document"
        />
      </div>
      {moved && (
        <button
          type="button"
          onClick={reset}
          {...PREVIEW_CONTROL_PROPS}
          data-testid="preview-reset-view"
          className="bg-background/90 text-muted-foreground hover:text-foreground absolute right-2 bottom-2 rounded border px-2 py-1 text-xs"
        >
          Reset view
        </button>
      )}
    </div>
  )
}
