import { nodeIdSchema } from '@kamiazya/whiteboard-canvas-model'
import { z } from 'zod'

/**
 * A peer's live presence: who they are, and optionally where their cursor
 * is and what they have selected. `peerId` is required — a presence update
 * with no identity is meaningless. `cursor`/`selection` are optional
 * because a peer may be connected without actively pointing at or
 * selecting anything.
 */
export const presenceStateSchema = z
  .object({
    peerId: z.string().min(1),
    cursor: z.object({ x: z.number(), y: z.number() }).strict().optional(),
    selection: z.array(nodeIdSchema).optional(),
  })
  .strict()

export type PresenceState = z.infer<typeof presenceStateSchema>

/**
 * Pub/sub contract for ephemeral (non-persisted) presence broadcast within
 * a document. `publish`/`subscribe` are control-plane operations (a
 * Promise-returning method and a callback/unsubscribe function are not
 * Zod-validatable values) and are deliberately exempt from the DTO rule;
 * the callback's PAYLOAD, `PresenceState`, is the DTO and IS validated by
 * `presenceStateSchema`.
 */
export interface PresenceChannel {
  publish(state: PresenceState): Promise<void>
  subscribe(onState: (state: PresenceState) => void): () => void
}
