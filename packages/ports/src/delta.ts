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

/**
 * When a delta log is worth folding back into its snapshot.
 *
 * Measured on a 20-node canvas, one delta per edit (Chromium):
 *
 *   edits   stored (base+deltas)   folded   ratio   replay
 *      10                 4.3 KB   1.6 KB   2.7x     ~5 ms
 *      50                17.5 KB   2.7 KB   6.5x     ~3 ms
 *     200                67.2 KB   6.3 KB  10.6x    ~10 ms
 *     500               166.6 KB  14.2 KB  11.7x    ~22 ms
 *
 * Reading a folded snapshot stayed near 1ms at every size, so the whole cost
 * is the replay, and both it and the waste grow without a bound.
 *
 * 64KB is the point in that table where replay is still ~10ms and the waste
 * is bounded at roughly ten times the real content. The daemon's
 * `SNAPSHOT_MAX_CHUNK_BYTES` (1MB) is deliberately NOT reused: that is where
 * a snapshot is split for storage, not where a log stops being worth keeping.
 *
 * It lives in `ports` because both keepers fold, and a threshold each one
 * re-derives from prose is a threshold they will re-derive differently — the
 * browser would compact at one size and the daemon at another, and a document
 * moving between them would change shape for no reason a reader could see.
 * The FOLD itself is not shared: it needs the CRDT runtime, and the two have
 * opposite material to hand — the daemon already holds the live document,
 * while the browser has only the stored bytes and must replay them.
 */
export const COMPACT_DELTA_BYTES = 64 * 1024

/**
 * Bytes, not entries. One pasted document and a thousand drags differ by
 * orders of magnitude, and it is the bytes that get replayed and stored.
 */
export function shouldCompact(deltas: readonly Uint8Array[] | undefined): boolean {
  if (deltas === undefined || deltas.length === 0) return false
  let total = 0
  for (const delta of deltas) total += delta.byteLength
  return total > COMPACT_DELTA_BYTES
}
