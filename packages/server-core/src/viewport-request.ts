import { MAX_VIEWPORT_ZOOM, MIN_VIEWPORT_ZOOM, nodeIdSchema } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/**
 * What a caller may ask of a watching browser's viewport — declared ONCE,
 * here, and read by every surface it crosses: `wb_viewport_set`'s input adds
 * the routing keys to it, the `CanvasClientNotifier` port carries it, the
 * daemon's HTTP viewport route parses a body against it, and daemon-client's
 * `viewport_request` wire message is this plus the daemon's stamp.
 *
 * It was three declarations with the same six fields — the tool's schema, a
 * hand-written port interface, and the wire schema — joined by a mapper that
 * copied the fields one by one into a `Record<string, unknown>`, so a field
 * added to two of the three and not the mapper was dropped on the way to the
 * browser, which then used its default and the tool reported success. That
 * is the `padding` incident the wire schema's own comment still cites.
 *
 * Strict, because the browser reads exactly these fields: a key it has never
 * read would be a silent no-op, and a value of the wrong type a frame it
 * drops, reported to the caller as a timeout.
 */
export const viewportRequestParamsSchema = z
  .object({
    mode: z
      .enum(['fit', 'move'])
      .optional()
      .describe(
        'fit frames elementIds (none: the whole board) and takes no scrollX, scrollY or zoom; move goes to scrollX, scrollY at zoom and takes no elementIds. Omitted: move if you give scrollX, scrollY or zoom, else fit.',
      ),
    /**
     * What to frame. Omitted with `mode: 'fit'` means the WHOLE board, which
     * is rarely what an agent pointing at something wants.
     */
    elementIds: z.array(nodeIdSchema).optional(),
    scrollX: z.number().finite().optional().describe('move: pan offset on x; omitted is 0.'),
    scrollY: z.number().finite().optional().describe('move: pan offset on y; omitted is 0.'),
    // Bounded by the editor's own range: an unbounded zoom is acted on or
    // dropped by the page while the tool still reports delivery.
    zoom: z
      .number()
      .min(MIN_VIEWPORT_ZOOM)
      .max(MAX_VIEWPORT_ZOOM)
      .optional()
      .describe(
        `Scale, ${MIN_VIEWPORT_ZOOM} to ${MAX_VIEWPORT_ZOOM}; 1 is actual size (not a percentage); omitted is 1.`,
      ),
  })
  .strict()

export type ViewportRequestParams = z.infer<typeof viewportRequestParamsSchema>

/** The params plus the document they are for, as the notifier port takes them. */
export interface ViewportRequest extends ViewportRequestParams {
  readonly workspaceId: string
  readonly documentId: string
}
