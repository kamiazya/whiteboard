// The widget's reader for `canvas_view`'s result, apart from the bundle entry so
// a test can import it: the entry pulls in the font module and the MCP Apps
// bridge, which nothing but a browser build resolves. The widget cannot import
// server-core, so the other end of this contract — mcp-server's
// `canvas-view-widget.contract.test.ts` — runs the real tool's output through
// this reader, since no compiler sees the two together.

import {
  CANVAS_VIEW_PICTURE_META_KEY,
  type CanvasViewPicture,
  canvasViewPictureSchema,
  type SpatialRenderStyle,
  spatialRenderStyleSchema,
  type ThemeFont,
  themeFontSchema,
} from '@kamiazya/whiteboard-canvas-render/canvas-view-picture'
import { z } from 'zod'

const toolResultEnvelopeSchema = z.object({
  structuredContent: z
    .object({
      workspaceId: z.string().optional(),
      documentId: z.string().optional(),
      // Parsed below: a style the schema does not know must cost the look on
      // the next refresh, never the picture.
      style: z.unknown().optional(),
      // The family the resolved theme names, and where the catalogue keeps
      // it. Deliberately a URL and not bytes: 4 MB through the model's
      // context, on every view, to say one word.
      themeFont: z.unknown().optional(),
    })
    // The scene, threads and references the model reads ride here too; the
    // widget draws the picture laid out from them instead.
    .catchall(z.unknown())
    .optional(),
  // Deliberately `unknown` per key: another key a host or server puts in
  // `_meta` is none of the widget's business.
  _meta: z.record(z.string(), z.unknown()).optional(),
})

/**
 * What the widget recovers from a `canvas_view` tool result — the envelope a
 * host delivers as `ui/notifications/tool-result` and the one
 * `app.callServerTool` resolves with. Total: a payload it cannot read yields
 * `{}`, and a key that fails its own schema costs that key alone.
 */
export function readCanvasViewResult(payload: unknown): {
  workspaceId?: string
  documentId?: string
  picture?: CanvasViewPicture
  style?: SpatialRenderStyle
  themeFont?: ThemeFont
} {
  const parsed = toolResultEnvelopeSchema.safeParse(payload)
  if (!parsed.success) return {}
  const structuredContent = parsed.data.structuredContent
  const picture = canvasViewPictureSchema.safeParse(
    parsed.data._meta?.[CANVAS_VIEW_PICTURE_META_KEY],
  )
  const style = spatialRenderStyleSchema.safeParse(structuredContent?.style)
  const themeFont = themeFontSchema.safeParse(structuredContent?.themeFont)
  return {
    workspaceId: structuredContent?.workspaceId,
    documentId: structuredContent?.documentId,
    ...(picture.success ? { picture: picture.data } : {}),
    ...(style.success ? { style: style.data } : {}),
    ...(themeFont.success ? { themeFont: themeFont.data } : {}),
  }
}
