import { z } from 'zod'
import { docRefSchema } from './doc-ref.js'
import { frontierSchema, protocolVersionSchema } from './frontier.js'

/**
 * The sync wire protocol between a client and its document sync endpoint.
 * Only `hello`/`welcome` carry version fields — every other variant is
 * `.strict()`, so a stray `protocolVersion(s)` field on a post-handshake
 * message is a validation error rather than silently ignored. `catchUp`
 * carries `docRef` (a prior design omitted it; every message that names an
 * operation on a document must be able to say which document).
 */
export const syncMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('hello'),
      protocolVersions: z.array(protocolVersionSchema).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('welcome'),
      protocolVersion: protocolVersionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('resume'),
      docRef: docRefSchema,
      frontier: frontierSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('catchUp'),
      docRef: docRefSchema,
      updates: z.array(z.instanceof(Uint8Array)),
      newFrontier: frontierSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('update'),
      docRef: docRefSchema,
      update: z.instanceof(Uint8Array),
      frontier: frontierSchema,
    })
    .strict(),
])

export type SyncMessage = z.infer<typeof syncMessageSchema>

/**
 * Picks the highest protocol version both sides support, or null when
 * there is no overlap. Pure and order-independent — it depends only on the
 * two version sets, not on the order either side listed them in.
 */
export function negotiateProtocolVersion(
  clientVersions: number[],
  serverVersions: number[],
): number | null {
  const serverSet = new Set(serverVersions)
  let best: number | null = null
  for (const version of clientVersions) {
    if (serverSet.has(version) && (best === null || version > best)) {
      best = version
    }
  }
  return best
}
