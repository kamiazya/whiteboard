// The widget's reader for `canvas_view`'s result, apart from the bundle entry so
// a test can import it: the entry pulls in the font module and the MCP Apps
// bridge, which nothing but a browser build resolves. The widget cannot import
// server-core, so the other end of this contract — mcp-server's
// `canvas-view-widget.contract.test.ts` — runs the real tool's output through
// this reader, since no compiler sees the two together.

import {
  type LoadedReference,
  loadedReferenceFromWire,
  loadedReferenceWireSchema,
  spatialRenderStyleSchema,
  type ThemeFont,
  themeFontSchema,
} from '@kamiazya/whiteboard-canvas-render'
import { type CommentThread, commentThreadSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { MountCanvasViewerOptions } from '../mount.js'

// Validated with the SAME schema `canvas_view` declares its payload with
// (canvas-render's `loadedReferenceWireSchema`), then lifted to the
// `LoadedReference` the seams read. A copy of that schema lived here and
// drifted: it took the model's canvas where the wire carries JSON Canvas,
// so every referenced board was dropped. Applied PER REFERENCE, so
// strictness costs only the reference that fails.

/**
 * Keeps the threads that parse, drops the ones that do not — per thread, like
 * the references, so one malformed conversation costs the highlight of that
 * conversation and never the scene.
 */
function parseThreads(raw: readonly unknown[] | undefined) {
  if (raw === undefined) return undefined
  const kept: CommentThread[] = []
  for (const value of raw) {
    const parsed = commentThreadSchema.safeParse(value)
    if (parsed.success) kept.push(parsed.data)
    else console.error('[whiteboard-widget] dropping unparseable thread:', parsed.error)
  }
  return kept.length > 0 ? kept : undefined
}

/** Keeps the references that parse, drops the ones that do not. */
function parseReferences(raw: Record<string, unknown> | undefined) {
  if (raw === undefined) return undefined
  const kept: Record<string, LoadedReference> = {}
  for (const [ref, value] of Object.entries(raw)) {
    const parsed = loadedReferenceWireSchema.safeParse(value)
    if (parsed.success) kept[ref] = loadedReferenceFromWire(parsed.data)
    else console.error('[whiteboard-widget] dropping unparseable reference:', ref, parsed.error)
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

const toolResultEnvelopeSchema = z.object({
  structuredContent: z
    .object({
      workspaceId: z.string().optional(),
      documentId: z.string().optional(),
      scene: z.unknown().optional(),
      // Deliberately `unknown` HERE, then parsed per entry below. Putting
      // the strict schema inline would make one bad reference fail the
      // whole envelope, discarding a perfectly good scene along with it —
      // the widget would go blank because a document it merely POINTS AT
      // was malformed.
      references: z.record(z.string(), z.unknown()).optional(),
      threads: z.array(z.unknown()).optional(),
      // Parsed below, like the references: a style the schema does not know
      // must cost the look, never the scene.
      style: z.unknown().optional(),
      // The family the resolved theme names, and where the catalogue keeps
      // it. Deliberately a URL and not bytes: 4 MB through the model's
      // context, on every view, to say one word.
      themeFont: z.unknown().optional(),
    })
    .catchall(z.unknown())
    .optional(),
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
  scene?: unknown
  references?: MountCanvasViewerOptions['references']
  threads?: MountCanvasViewerOptions['threads']
  style?: MountCanvasViewerOptions['style']
  themeFont?: ThemeFont
} {
  const parsed = toolResultEnvelopeSchema.safeParse(payload)
  if (!parsed.success) return {}
  const structuredContent = parsed.data.structuredContent
  const style = spatialRenderStyleSchema.safeParse(structuredContent?.style)
  const themeFont = themeFontSchema.safeParse(structuredContent?.themeFont)
  return {
    workspaceId: structuredContent?.workspaceId,
    documentId: structuredContent?.documentId,
    scene: structuredContent?.scene,
    references: parseReferences(structuredContent?.references),
    threads: parseThreads(structuredContent?.threads),
    ...(style.success ? { style: style.data } : {}),
    ...(themeFont.success ? { themeFont: themeFont.data } : {}),
  }
}
