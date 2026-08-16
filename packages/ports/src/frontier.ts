import { z } from 'zod'

/**
 * A Frontier is an opaque, serialized version vector — ports makes
 * NO ordering/dominance/comparison claim about its contents. Comparing two
 * frontiers (e.g. deciding whether one dominates another) requires the CRDT
 * runtime (loro-crdt) and belongs in codec/crdt, not in
 * this loro-independent contracts package. An empty Uint8Array is a valid
 * frontier (a brand-new document has no history yet).
 */
export const frontierSchema = z.instanceof(Uint8Array)

export type Frontier = z.infer<typeof frontierSchema>

/** Sync-protocol version numbers are positive integers, e.g. 1, 2, 3. */
export const protocolVersionSchema = z.number().int().min(1)

export type ProtocolVersion = z.infer<typeof protocolVersionSchema>
