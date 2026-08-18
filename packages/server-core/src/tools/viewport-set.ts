import { documentIdSchema, nodeIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { assertDocumentInWorkspace } from './assert-document-in-workspace.js'

const viewportSetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    /** `fit` frames the given elements (or the whole board); `move` pans without rescaling. */
    mode: z.enum(['fit', 'move']).optional(),
    /**
     * What to frame. Omitted with `mode: 'fit'` means the WHOLE board, which
     * is rarely what an agent pointing at something wants.
     */
    elementIds: z.array(nodeIdSchema).optional(),
    animate: z.boolean().optional(),
    scrollX: z.number().finite().optional(),
    scrollY: z.number().finite().optional(),
    zoom: z.number().finite().optional(),
  })
  .strict()
type ViewportSetInput = z.infer<typeof viewportSetInputSchema>

const viewportSetOutputSchema = z
  .object({
    documentId: documentIdSchema,
    /**
     * Whether a browser was actually watching. A headless daemon is the
     * normal case rather than an error, so this is a reported fact and not
     * a thrown one — an agent that could not tell the difference would read
     * every headless run as broken.
     */
    delivered: z.boolean(),
  })
  .strict()
type ViewportSetOutput = z.infer<typeof viewportSetOutputSchema>

/**
 * Points a watching browser at part of a canvas.
 *
 * The `viewport_request` WebSocket message this rides has existed since the
 * daemon's HTTP viewport route was added; until now nothing exposed it to an
 * agent, while `routes/viewport.ts`'s own no-client hint told callers to
 * "run viewport_set" — a tool that did not exist.
 *
 * `wb_canvas_edit` already follows its own edits, so reach for this when an
 * agent wants to point at something it did NOT just change: reviewing a
 * board with a human, walking through a diagram, answering "where is X".
 */
export function createViewportSetTool(deps: ServerDeps) {
  return {
    name: 'wb_viewport_set' as const,
    description:
      "Move a watching browser's view of a spatial canvas: frame specific elements, or pan and zoom directly. Answers delivered:false rather than failing when no browser is open, so it is safe to call headlessly. wb_canvas_edit already follows its own edits — use this to point at something you did not just change.",
    inputSchema: viewportSetInputSchema,
    outputSchema: viewportSetOutputSchema,
    async execute(input: ViewportSetInput): Promise<ViewportSetOutput> {
      await assertDocumentInWorkspace(deps.documentIndex, input.workspaceId, input.documentId)

      const notifier = deps.clientNotifier
      if (notifier === undefined) return { documentId: input.documentId, delivered: false }

      // Field by field, never a spread of `input`: `workspaceId` is the
      // routing key rather than a viewport parameter, and a future input
      // field must not reach the browser just because it was added here.
      const delivered = await notifier.requestViewport({
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        ...(input.mode === undefined ? {} : { mode: input.mode }),
        ...(input.elementIds === undefined ? {} : { elementIds: input.elementIds }),
        ...(input.animate === undefined ? {} : { animate: input.animate }),
        ...(input.scrollX === undefined ? {} : { scrollX: input.scrollX }),
        ...(input.scrollY === undefined ? {} : { scrollY: input.scrollY }),
        ...(input.zoom === undefined ? {} : { zoom: input.zoom }),
      })

      return { documentId: input.documentId, delivered }
    },
  }
}
