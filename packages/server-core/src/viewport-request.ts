import { nodeIdSchema } from '@kamiazya/whiteboard-model'
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

export type ViewportRequestParams = z.infer<typeof viewportRequestParamsSchema>

/** The params plus the document they are for, as the notifier port takes them. */
export interface ViewportRequest extends ViewportRequestParams {
  readonly workspaceId: string
  readonly documentId: string
}
