import type { MdastLayoutOptions, MeasureText } from '@kamiazya/whiteboard-canvas-render'
import type { AliasResolver } from '@kamiazya/whiteboard-codec'
import { type CSSProperties, type MutableRefObject, useEffect, useMemo } from 'react'
import type { ResolvedTheme } from '../../hooks/useThemeMode.js'
import { editorTextFill } from '../spatial-editor/editor-appearance.js'
import type { RailBlock } from './rail-geometry.js'
import { type PreviewBlockAnchor, renderMarkdownPreview } from './render-preview.js'

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
  /** Renders math blocks; see render-preview.ts. */
  renderMath?: MdastLayoutOptions['renderMath']
  /** Renders diagram fences; see render-preview.ts. */
  renderDiagram?: MdastLayoutOptions['renderDiagram']
  /**
   * Filled with the current render's per-block scroll-sync anchors (see
   * render-preview.ts). A ref, not a callback into state: the consumer is
   * a scroll handler that reads lazily, and routing anchors through state
   * would re-render the whole editor once per preview render for data
   * only that handler looks at.
   */
  anchorsRef?: MutableRefObject<readonly PreviewBlockAnchor[]>
  /**
   * Each top-level block's box, for the rail beside this pane. Surfaced the
   * same way as anchors — through a ref rather than a callback — so a
   * re-render of the pane does not re-render whatever holds the rail.
   */
  blocksRef?: MutableRefObject<readonly RailBlock[]>
}

/**
 * Renders `value` through the SVG string produced by
 * `renderMarkdownPreviewSvg` (codec -> canvas-render). Injecting that
 * string via `dangerouslySetInnerHTML` carries the same soundness rationale
 * as `packages/canvas-viewer/src/CanvasViewer.tsx`: canvas-render's
 * serializer is the SOLE producer of this string and escapes text content
 * (`&`/`<`/`>`) and attribute values (`"`/`'`) — there is no untrusted-HTML
 * injection path here. The one addition to that reasoning: `renderMath` /
 * `renderDiagram` fragments are emitted verbatim by the backend, so they
 * must come only from engines safe against untrusted document text —
 * MathJax typesets into its own glyph paths, and mermaid runs at
 * securityLevel 'strict' (see markdown-fragment-renderers.ts). Do not add
 * a sanitizer dependency; if this string ever stops being canvas-render's
 * own output plus those two engines' fragments, this reasoning no longer
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
  renderMath,
  renderDiagram,
  anchorsRef,
  blocksRef,
}: PreviewPaneProps) {
  const { svg, anchors, blocks } = useMemo(
    () =>
      renderMarkdownPreview(value, {
        measure,
        maxWidth,
        background,
        resolveAlias,
        resolveEmbed,
        renderMath,
        renderDiagram,
      }),
    [value, measure, maxWidth, background, resolveAlias, resolveEmbed, renderMath, renderDiagram],
  )
  useEffect(() => {
    if (anchorsRef) anchorsRef.current = anchors
    if (blocksRef) blocksRef.current = blocks
  }, [anchors, anchorsRef, blocks, blocksRef])

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
      // biome-ignore lint/security/noDangerouslySetInnerHtml: canvas-render's SVG serializer is the sole producer of this string and escapes text and attribute values (svg/format.ts)
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
