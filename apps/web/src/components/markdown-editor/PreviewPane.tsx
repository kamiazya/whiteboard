import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { useMemo } from 'react'
import { renderMarkdownPreviewSvg } from './render-preview.js'

export interface PreviewPaneProps {
  value: string
  maxWidth: number
  measure: MeasureText
  background?: string
}

/**
 * Renders `value` through the SVG string produced by
 * `renderMarkdownPreviewSvg` (canvas-codec -> canvas-render). Injecting that
 * string via `dangerouslySetInnerHTML` carries the same soundness rationale
 * as `packages/canvas-viewer/src/CanvasViewer.tsx`: canvas-render's
 * serializer is the SOLE producer of this string and escapes text content
 * (`&`/`<`/`>`) and attribute values (`"`/`'`) — there is no untrusted-HTML
 * injection path here. Do not add a sanitizer dependency; if this string
 * ever stops being canvas-render's own output, this reasoning no longer
 * holds and must be revisited.
 */
export function PreviewPane({ value, maxWidth, measure, background }: PreviewPaneProps) {
  const svg = useMemo(
    () => renderMarkdownPreviewSvg(value, { measure, maxWidth, background }),
    [value, measure, maxWidth, background],
  )

  return (
    <div
      data-testid="markdown-preview-pane"
      style={{ overflow: 'auto' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
