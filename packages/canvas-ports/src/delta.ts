import { z } from 'zod'
import { frontierSchema } from './frontier.js'

/**
 * A batch of one or more opaque CRDT update payloads plus the frontier the
 * receiver reaches once every update in the batch is applied. `updates`
 * requires at least one element — a batch with zero updates carries no
 * information and its caller should not construct one.
 */
export const deltaBatchSchema = z
  .object({
    updates: z.array(z.instanceof(Uint8Array)).min(1),
    newFrontier: frontierSchema,
  })
  .strict()

export type DeltaBatch = z.infer<typeof deltaBatchSchema>
