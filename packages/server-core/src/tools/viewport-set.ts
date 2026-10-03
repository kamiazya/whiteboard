import { documentIdSchema, workspaceIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { ServerDeps } from '../server-deps.js'
import { viewportRequestParamsSchema } from '../viewport-request.js'
import { resolveDocumentInWorkspace } from './assert-document-in-workspace.js'
import { DocumentKindMismatchError } from './errors.js'

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
      "Move a watching browser's view of a spatial canvas: frame specific elements, or pan and zoom directly. Answers delivered:false rather than failing when no browser is open, so it is safe to call headlessly. wb_canvas_edit already follows its own edits — use this to point at something you did not just change.",
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
