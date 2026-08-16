import {
  documentIdSchema,
  spatialCanvasSchema,
  workspaceIdSchema,
} from '@kamiazya/whiteboard-model'
import { mdastRootSchema } from '@kamiazya/whiteboard-model/mdast'
import { z } from 'zod'
import { loadSpatialCanvas } from '../render/load-spatial-canvas.js'
import { resolveFileReferences } from '../render/resolve-file-references.js'
import type { ServerDeps } from '../server-deps.js'

/**
 * What one file reference resolved to, as the widget receives it.
 *
 * Schematized rather than passed as `unknown` because this payload crosses
 * TWO process boundaries — server to MCP host, host to the widget document —
 * and the widget re-validates on arrival. A hand-written type on the widget
 * side paired with an unschematized payload here is exactly the drift
 * zod-schema-discipline exists to prevent.
 */
export const canvasViewReferenceSchema = z
  .object({
    /** The document's display name, so the node's label is not a raw id. */
    label: z.string().optional(),
    /** Present only for a markdown document: its body, already parsed. */
    body: mdastRootSchema.optional(),
  })
  .strict()

export const canvasViewInputSchema = z
  .object({ workspaceId: workspaceIdSchema, documentId: documentIdSchema })
  .strict()
export type CanvasViewInput = z.infer<typeof canvasViewInputSchema>

export const canvasViewOutputSchema = z
  .object({
    /**
     * Echoed so the widget's Refresh control can re-invoke this tool for the
     * same canvas without the host having to remember what it asked for.
     */
    documentId: documentIdSchema,
    /** The document itself: the widget lays it out, it is not pre-rendered. */
    scene: spatialCanvasSchema,
    /**
     * File reference -> what it resolves to. Keyed by the raw `file` value
     * on the node, which is what the widget's seam is called with.
     */
    references: z.record(z.string(), canvasViewReferenceSchema),
  })
  .strict()
export type CanvasViewOutput = z.infer<typeof canvasViewOutputSchema>

/**
 * The MCP Apps (SEP-1865) inline canvas view. Its result is linked to the
 * `ui://whiteboard/canvas-view` widget resource by the registration's
 * `_meta.ui.resourceUri`, so a host that supports the extension renders it
 * rather than showing JSON.
 *
 * References are resolved UNCONDITIONALLY here, unlike `wb_scene_render`'s
 * opt-in `embedReferences`. That flag exists because the render tool shares
 * its scene builder with `wb_scene_digest`, whose usefulness depends on a
 * canvas's digest not moving when a different document is edited. This tool
 * has no such sibling: its one consumer is a viewer for a human, which
 * always wants the reference resolved, and it has no store of its own to
 * resolve them with.
 */
export function createCanvasViewTool(deps: ServerDeps) {
  return {
    name: 'canvas_view' as const,
    description:
      'Show a canvas inline in the chat as an interactive read-only view. Returns the scene plus its resolved file references, so a node referencing a markdown document shows that document. Read-only: it renders what is stored and changes nothing.',
    inputSchema: canvasViewInputSchema,
    outputSchema: canvasViewOutputSchema,
    async execute(input: CanvasViewInput): Promise<CanvasViewOutput> {
      const { canvas } = await loadSpatialCanvas(deps, input.documentId)
      const resolved = await resolveFileReferences(deps, input.workspaceId, canvas)
      return {
        documentId: input.documentId,
        scene: canvas,
        // `markdown` -> `body` is the one place the internal record and the
        // wire disagree. The record is canvas-render's `ResolvedReference`,
        // which names every content kind it can carry; this schema names
        // only the two a widget receives, and renaming a published tool's
        // field is its own increment (vocabulary.md).
        references: Object.fromEntries(
          [...resolved].map(([ref, { label, markdown }]) => [
            ref,
            {
              ...(label !== undefined ? { label } : {}),
              ...(markdown !== undefined ? { body: markdown } : {}),
            },
          ]),
        ),
      }
    },
  }
}
