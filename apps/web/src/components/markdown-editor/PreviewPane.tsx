import type { AliasResolver } from '@kamiazya/whiteboard-canvas-codec'
import type { MdastLayoutOptions, MeasureText } from '@kamiazya/whiteboard-canvas-render'
import { type CSSProperties, useMemo } from 'react'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { editorTextFill } from '../spatial-editor/editor-appearance.js'
import { renderMarkdownPreviewSvg } from './render-preview.js'

export interface PreviewPaneProps {
  value: string
  maxWidth: number
  measure: MeasureText
  background?: string
  theme?: ResolvedTheme
  /** Maps `[[Name]]` aliases to canvas ids; see render-preview.ts. */
  resolveAlias?: AliasResolver
  /** Resolves `![[embed]]` bodies for inline rendering; see render-preview.ts. */
  resolveEmbed?: MdastLayoutOptions['resolveEmbed']
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
  resolveAlias,
  resolveEmbed,
}: PreviewPaneProps) {
  const svg = useMemo(
    () =>
      renderMarkdownPreviewSvg(value, {
        measure,
        maxWidth,
        background,
        resolveAlias,
        resolveEmbed,
      }),
    [value, measure, maxWidth, background, resolveAlias, resolveEmbed],
  )

  const fill = editorTextFill(theme)
  return (
    <div
      data-testid="markdown-preview-pane"
      className="markdown-preview-pane"
      // `fill` on the host, not in the SVG: canvas-render assigns markdown
      // body runs no fill of their own, so each `<text>` would otherwise take
      // the SVG default — black — on every theme, leaving the dark preview
      // black on near-black. Inheriting from here themes every run at once
      // and keeps color out of the render path, so exported SVG bytes stay
      // independent of whichever theme the viewer happens to be using.
      //
      // `--preview-fill` repeats the same value for the anchor rule in
      // index.css: Chromium repaints an SVG <a>'s fill with its UA :visited
      // color and, in visited context, honors only an explicit color value
      // (var() included) — `inherit` is ignored, so inheritance alone leaves
      // a visited wikiLink near-invisible.
      style={{ overflow: 'auto', fill, '--preview-fill': fill } as CSSProperties}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
