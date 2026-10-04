import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import { loadDocument } from '../document-io.js'
import type { ServerDeps } from '../server-deps.js'
import { viewportRequestParamsSchema } from '../viewport-request.js'
import { resolveDocumentInWorkspace } from './assert-document-in-workspace.js'
import { DocumentKindMismatchError, NodeNotFoundError } from './errors.js'

// The routing keys first, then the shared params by their one declaration —
// written as a shape spread rather than `.extend`, so the keys a model reads
// keep the order they have always had.
const viewportSetInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    documentId: documentIdSchema,
    ...viewportRequestParamsSchema.shape,
  })
  .strict()
  // The browser applies exactly one half of a request — fit reads elementIds,
  // move reads scrollX/scrollY/zoom — and drops the other while the tool
  // answers delivered:true. Refused here rather than on the shared params
  // (which the wire frame is also built from) so a frame from an older
  // daemon is still applied as the browser always has.
  .superRefine((input, ctx) => {
    const positioned =
      input.scrollX !== undefined || input.scrollY !== undefined || input.zoom !== undefined
    if (input.elementIds !== undefined && positioned) {
      ctx.addIssue({
        code: 'custom',
        message:
          'elementIds (frame these) and scrollX, scrollY or zoom (go to this position) cannot be sent together — the browser would apply only one. Send one or the other.',
      })
    } else if (input.mode === 'fit' && positioned) {
      ctx.addIssue({
        code: 'custom',
        message:
          'mode fit takes no scrollX, scrollY or zoom — it frames elementIds, or the whole board. Use mode move to go to a position.',
      })
    } else if (input.mode === 'move' && input.elementIds !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message:
          'mode move takes no elementIds — it goes to scrollX, scrollY at zoom. Use mode fit to frame elements.',
      })
    }
  })
type ViewportSetInput = z.infer<typeof viewportSetInputSchema>

const viewportSetOutputSchema = z
  .object({
    documentId: documentIdSchema,
    /**
     * Whether a browser was actually watching, and so was TOLD. The page sends
     * no acknowledgement, so this is not "the view moved". A headless daemon
     * is the normal case rather than an error, so this is a reported fact and
     * not a thrown one — an agent that could not tell the difference would
     * read every headless run as broken.
     */
    delivered: z
      .boolean()
      .describe('True when a subscribed browser was sent the request; the page does not confirm.'),
  })
  .strict()
type ViewportSetOutput = z.infer<typeof viewportSetOutputSchema>

/**
 * Points a watching browser at part of a canvas.
 *
 * The `viewport_request` text frame this rides has existed since the
 * daemon's HTTP viewport route was added; until now nothing exposed it to an
 * agent, while `server/viewport-requests.ts`'s own no-client hint told callers to
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
      "Move a watching browser's view of a spatial canvas: frame specific elements, or pan and zoom directly. Answers delivered:false rather than failing when no browser is open, so it is safe to call headlessly; delivered:true means a browser was told, not that it confirmed. wb_canvas_edit already follows its own edits — use this to point at something you did not just change.",
    inputSchema: viewportSetInputSchema,
    outputSchema: viewportSetOutputSchema,
    async execute(input: ViewportSetInput): Promise<ViewportSetOutput> {
      const entry = await resolveDocumentInWorkspace(
        deps.documentIndex,
        input.workspaceId,
        input.documentId,
      )
      // Only a document KNOWN to be markdown is refused, as its siblings do:
      // one that records no kind predates them and may be a canvas.
      if (entry.kind === 'markdown') {
        throw new DocumentKindMismatchError(
          input.documentId,
          entry.kind,
          'wb_viewport_set moves the view of a spatial canvas, and a markdown document has none.',
        )
      }

      // Before the notifier is consulted: with no browser open a typo'd id
      // would otherwise read exactly like a correct one, and with one open it
      // would frame nothing and still be reported delivered.
      if (input.elementIds !== undefined && input.elementIds.length > 0) {
        const { canvas } = await loadDocument(deps, input.workspaceId, input.documentId)
        const present = new Set(canvas.nodes.map((node) => node.id))
        const missing = input.elementIds.find((id) => !present.has(id))
        if (missing !== undefined) throw new NodeNotFoundError(input.documentId, missing)
      }

      const notifier = deps.clientNotifier
      if (notifier === undefined) return { documentId: input.documentId, delivered: false }

      // Everything but the routing keys IS the viewport request, by the one
      // declaration both the tool and the wire derive from — so a parameter
      // added there reaches the browser without a second list to keep in
      // step. The schema has already dropped what was not sent.
      const delivered = await notifier.requestViewport(input)

      return { documentId: input.documentId, delivered }
    },
  }
}
