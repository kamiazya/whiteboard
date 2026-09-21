/**
 * What a worker reply looks like once it has been through JSON, and how it
 * comes back.
 *
 * The render store (ADR-0027 decision 5) keeps replies in OPFS as JSON, and
 * the worker posts a hit straight on to the asking thread. Two things follow
 * that the live path never has to think about, and this module is both of
 * them in one place.
 *
 * **A stored reply is not the reply.** `layout-worker-protocol.ts`'s own
 * header says it: postMessage is structuredClone, which "preserves
 * `undefined`-valued keys, Maps and Dates that a JSON round trip would
 * quietly drop". `laid-out` carries `anchors` as a `ReadonlyMap`, and
 * `JSON.stringify(new Map([['a', 1]]))` is `{}` — so an entry written by
 * spreading the live reply comes back as a `laid-out` whose anchors are an
 * empty object, posted under a type that says they are a Map. Nothing has
 * read them from a stored reply yet (only the list surfaces pass a cache key,
 * and a row reads `svg`/`bounds`/`fontsMissing`), which is why it has cost
 * nothing so far and why nothing would have said when it started to.
 * `encodeStoredReply` writes the entries; `decodeStoredReply` rebuilds the
 * Map.
 *
 * **A stored reply is INPUT.** It was written by an older build, by another
 * tab, or by whatever else can reach this origin's OPFS, and the live path's
 * trust — "this worker built it a microsecond ago" — does not carry over.
 * So a hit is PARSED rather than cast, and an entry that does not parse is a
 * miss: the caller renders, which is what every other failure in the store
 * already answers.
 *
 * `scene` stays `z.unknown()` deliberately: it is `canvas-render`'s own
 * structural type, and a second declaration of it here would be a copy that
 * drifts — exactly what the Zod discipline exists to prevent. What this
 * schema guarantees is the ENVELOPE a consumer dispatches on and the fields
 * it reads.
 */
import type { EdgeAnchorPair } from '@kamiazya/whiteboard-canvas-render'
import { z } from 'zod'

const boundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite(),
    h: z.number().finite(),
  })
  .loose()

/** A rect the favicon/outline surfaces draw; `color` is resolved by the worker. */
const rectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite(),
    h: z.number().finite(),
  })
  .loose()

/**
 * The reply kinds the worker stores, in the shape JSON leaves them.
 *
 * `.loose()` on each arm rather than `.strict()`: a stored entry may carry a
 * field a later build added and this one does not read, and refusing it would
 * turn every entry written by the NEXT build into a miss for the current one.
 * The narrowing that matters is the discriminator plus the fields a consumer
 * reads.
 */
export const storedReplySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('outlined'), rects: z.array(rectSchema) }).loose(),
  z
    .object({ type: z.literal('markdown-render-done'), svg: z.string(), bounds: boundsSchema })
    .loose(),
  z
    .object({
      type: z.literal('laid-out'),
      svg: z.string(),
      bounds: boundsSchema,
      scene: z.unknown(),
      /** Written as entries, because a Map does not survive JSON. */
      anchors: z.array(z.tuple([z.string(), z.unknown()])),
      fontsMissing: z.array(z.string()).optional(),
    })
    .loose(),
])

export type StoredReply = z.infer<typeof storedReplySchema>

/**
 * The reply as it should be WRITTEN: without the request id it answered, and
 * with anything JSON cannot carry turned into something it can.
 */
export function encodeStoredReply(reply: {
  readonly type: string
  readonly id: number
  // The rest of the reply, whatever kind it is: this function's job is the
  // two fields above and anything JSON cannot carry, never the payload.
  readonly [field: string]: unknown
}): unknown {
  const { id: _id, ...rest } = reply as Record<string, unknown> & { id: number }
  const anchors = (rest as { anchors?: unknown }).anchors
  if (anchors instanceof Map) return { ...rest, anchors: [...anchors.entries()] }
  return rest
}

/**
 * A parsed entry as the reply it stands for, ready to post under a fresh id.
 *
 * Answers `null` for an entry that does not parse, which the worker treats as
 * a miss.
 */
export function decodeStoredReply(stored: unknown): Record<string, unknown> | null {
  const parsed = storedReplySchema.safeParse(stored)
  if (!parsed.success) return null
  if (parsed.data.type !== 'laid-out') return { ...parsed.data }
  const { anchors, ...rest } = parsed.data
  return { ...rest, anchors: new Map(anchors as readonly (readonly [string, EdgeAnchorPair])[]) }
}
