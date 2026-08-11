import type { MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { useMemo } from 'react'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { editorTextFill } from '../spatial-editor/editor-appearance.js'
import { renderMarkdownPreviewSvg } from './render-preview.js'

export interface PreviewPaneProps {
  value: string
  maxWidth: number
  measure: MeasureText
  background?: string
  theme?: ResolvedTheme
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
export function PreviewPane({
  value,
  maxWidth,
  measure,
  background,
  theme = 'light',
}: PreviewPaneProps) {
  const svg = useMemo(
    () => renderMarkdownPreviewSvg(value, { measure, maxWidth, background }),
    [value, measure, maxWidth, background],
  )

  return (
    <div
      data-testid="markdown-preview-pane"
      // `fill` on the host, not in the SVG: canvas-render assigns markdown
      // body runs no fill of their own, so each `<text>` would otherwise take
      // the SVG default — black — on every theme, leaving the dark preview
      // black on near-black. Inheriting from here themes every run at once
      // and keeps color out of the render path, so exported SVG bytes stay
      // independent of whichever theme the viewer happens to be using.
      style={{ overflow: 'auto', fill: editorTextFill(theme) }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
