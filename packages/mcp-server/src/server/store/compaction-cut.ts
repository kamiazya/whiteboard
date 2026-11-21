import { compactionCut } from '@kamiazya/whiteboard-history'
import type { RecordSession } from '@kamiazya/whiteboard-loro-adapter'

type Entries = readonly { peer: string; counter: number }[]

const versionOf = (entries: Entries) => new Map(entries.map(({ peer, counter }) => [peer, counter]))

/**
 * `compactionCut` over a live record: each point's frontiers (as the engine
 * encodes them) are turned into the version they stand for here, where the op
 * log is, and the cut is turned back into the version the shallow snapshot is
 * taken at. A point the record does not hold has no version, and then there is
 * nothing to cut; neither is there one that falls before the record's own
 * shallow root, which can no longer check out anything earlier.
 */
export function compactionCutOfRecord(
  record: Pick<RecordSession, 'versionAt' | 'shallowRootVersion'>,
  points: readonly Uint8Array[],
): { peer: string; counter: number }[] | null {
  let vectors: Map<string, number>[]
  try {
    vectors = points.map((point) => versionOf(record.versionAt(point).entries))
  } catch {
    return null
  }
  const cut = compactionCut(vectors, versionOf(record.shallowRootVersion()))
  return cut === null ? null : [...cut].map(([peer, counter]) => ({ peer, counter }))
}
