/**
 * When a local document's delta log is worth folding back into its snapshot.
 *
 * Measured on a 20-node canvas, one delta per edit (Chromium, this machine):
 *
 *   edits   stored (base+deltas)   folded   ratio   replay
 *      10                 4.3 KB   1.6 KB   2.7x     ~5 ms
 *      50                17.5 KB   2.7 KB   6.5x     ~3 ms
 *     200                67.2 KB   6.3 KB  10.6x    ~10 ms
 *     500               166.6 KB  14.2 KB  11.7x    ~22 ms
 *
 * Reading a folded snapshot stayed near 1ms at every size, so the whole cost
 * is the replay, and both it and the waste grow without a bound — the log
 * had no cap and no compaction at all.
 *
 * 64KB is the point in that table where replay is still ~10ms and the waste
 * is bounded at roughly ten times the real content. The daemon's
 * `SNAPSHOT_MAX_CHUNK_BYTES` (1MB) is deliberately NOT reused: that is where
 * a snapshot is split for storage, not where a log stops being worth keeping.
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
