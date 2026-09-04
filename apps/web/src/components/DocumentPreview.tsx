import { CanvasViewer, createBrowserMeasureText } from '@kamiazya/whiteboard-canvas-viewer'
import { type JSX, useMemo } from 'react'
import type { ResolvedTheme } from '@/hooks/useThemeMode'
import type { PastDocument } from '@/lib/versions-backend'
import { PreviewPane } from './markdown-editor/PreviewPane.js'

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
 * is not the editor, so nothing here pans, selects or types.
 */
export function DocumentPreview({
  past,
  theme,
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
        <PreviewPane
          value={past.body}
          maxWidth={maxWidth}
          measure={measure}
          {...(theme === undefined ? {} : { theme })}
        />
      </div>
    )
  }
  return (
    <div data-testid="document-preview" className="h-full min-h-0 overflow-auto">
      <CanvasViewer canvas={past.canvas} measure={measure} label="A past state of this document" />
    </div>
  )
}
