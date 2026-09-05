/**
 * Which lazily-created containers are mergeable, and which deliberately are
 * not.
 *
 * `openMergeable*` fixes a real class of silent loss (see
 * `comment-threads.convergence.test.ts`), and it is not free: a mergeable
 * child's id is deterministic rather than an op id, and every write into one
 * encodes that. Measured with the whole package on it, against
 * `workspace-record-growth.test.ts`'s scoreboard:
 *
 * | scoreboard number      | regular | mergeable | delta  |
 * |------------------------|---------|-----------|--------|
 * | one document, no edits | 919 B   | 1069 B    | +16.3% |
 * | 10 docs x 100 edits    | 178560 B| 211860 B  | +18.6% |
 *
 * Attributed rather than assumed: reverting `workspace-tree.ts` alone put
 * every number back, so the whole cost is the per-document CONTENT
 * containers and the thread plane's share of it is zero.
 *
 * That is why the swap is not blanket. A document's content containers are
 * pre-attached by whoever creates the document (`attachContentContainers`
 * over `CONTENT_CONTAINER_KEYS`), so they travel in the op log and a second
 * replica never opens one first — the hazard is already closed there, and
 * paying 18.6% of the delta log to close it twice would be paid by the
 * compaction subsystem forever. A thread's key is the caller's comment id
 * and nothing pre-attaches it, so there the hazard is real and the cost is
 * nil.
 *
 * The scan below is what keeps that a decision. A container opened the
 * regular way is fine where it is reasoned about; a NEW one, written by
 * habit next to the existing ones, would reopen the loss in silence.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LoroDoc, LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import {
  openMergeableMap,
  openMergeableMovableList,
  openMergeableText,
} from './mergeable-containers.js'

/**
 * Files allowed to open a REGULAR child container, with why and how many.
 *
 * The count is pinned by equality on purpose: a ninth call in
 * `workspace-tree.ts` is a new lazily-created container, which is exactly
 * the decision this file exists to force someone to take.
 */
const REGULAR_CONTAINER_SITES: Record<string, { calls: number; reason: string }> = {
  'mergeable-containers.ts': {
    calls: 3,
    reason:
      'the helper itself: an occupied key keeps the behaviour it had, because ensureMergeable* throws on one',
  },
  'workspace-tree.ts': {
    calls: 9,
    reason:
      "a document's content containers, pre-attached at creation from CONTENT_CONTAINER_KEYS so no replica opens one first; mergeable costs 18.6% of the delta log here for a hazard that is already closed",
  },
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : []
  })
}

/** Calls only — the word appears in prose in several files that make none. */
function countCalls(source: string): number {
  return (source.match(/\.getOrCreateContainer\(/g) ?? []).length
}

const CALLS_BY_FILE = new Map(
  sourceFiles(new URL('.', import.meta.url).pathname)
    .map(
      (path) =>
        [path.slice(path.lastIndexOf('/') + 1), countCalls(readFileSync(path, 'utf8'))] as const,
    )
    .filter(([, calls]) => calls > 0),
)

describe('regular container sites', () => {
  it('scanned a plausible number of files', () => {
    // A regex that stops matching would otherwise report itself as "every
    // entry is stale", which sends the reader to the wrong file entirely.
    expect(sourceFiles(new URL('.', import.meta.url).pathname).length).toBeGreaterThan(10)
    expect(CALLS_BY_FILE.size).toBeGreaterThan(0)
  })

  it('opens a regular container only where a reason is recorded', () => {
    expect([...CALLS_BY_FILE.keys()].sort()).toEqual(Object.keys(REGULAR_CONTAINER_SITES).sort())
  })

  it('records no more calls than the file makes, and no fewer', () => {
    const declared = Object.fromEntries(
      Object.entries(REGULAR_CONTAINER_SITES).map(([file, { calls }]) => [file, calls]),
    )
    expect(Object.fromEntries(CALLS_BY_FILE)).toEqual(declared)
  })
})

describe('openMergeable*', () => {
  it('adopts a container an earlier regular write already left at the key', () => {
    // The whole reason for the helper: `ensureMergeable*` throws on a key
    // holding a non-mergeable value, and every document stored before this
    // change has exactly that.
    const doc = new LoroDoc()
    doc.getMap('m').getOrCreateContainer('k', new LoroMap()).set('written-before', 1)
    doc.commit()

    openMergeableMap(doc.getMap('m'), 'k').set('written-after', 2)
    doc.commit()

    expect(doc.toJSON().m.k).toEqual({ 'written-before': 1, 'written-after': 2 })
  })

  /**
   * Two peers with a common ancestor that does NOT hold the key, each
   * writing something the other cannot produce. Asserting on the merged
   * CONTENT of both, because "they converged" alone passes when both
   * converged on the loss.
   */
  function twoReplicas(): [LoroDoc, LoroDoc] {
    const a = new LoroDoc()
    a.setPeerId(1)
    const b = new LoroDoc()
    b.setPeerId(2)
    a.getMap('m').set('seed', 1)
    a.commit()
    b.import(a.export({ mode: 'snapshot' }))
    return [a, b]
  }

  function exchange(a: LoroDoc, b: LoroDoc): void {
    a.commit()
    b.commit()
    a.import(b.export({ mode: 'update' }))
    b.import(a.export({ mode: 'update' }))
  }

  it('merges a map two replicas created at once', () => {
    const [a, b] = twoReplicas()
    openMergeableMap(a.getMap('m'), 'k').set('a', 'a')
    openMergeableMap(b.getMap('m'), 'k').set('b', 'b')

    exchange(a, b)

    expect(a.toJSON().m.k).toEqual({ a: 'a', b: 'b' })
    expect(b.toJSON().m.k).toEqual({ a: 'a', b: 'b' })
  })

  it('merges a text two replicas created at once', () => {
    const [a, b] = twoReplicas()
    openMergeableText(a.getMap('m'), 'k').insert(0, 'a')
    openMergeableText(b.getMap('m'), 'k').insert(0, 'b')

    exchange(a, b)

    // Both characters survive; which order the two concurrent inserts take
    // is Loro's to decide, so only the SET is asserted.
    expect([...String(a.toJSON().m.k)].sort()).toEqual(['a', 'b'])
    expect(a.toJSON().m.k).toEqual(b.toJSON().m.k)
  })

  it('merges a movable list two replicas created at once', () => {
    const [a, b] = twoReplicas()
    openMergeableMovableList(a.getMap('m'), 'k').push('a')
    openMergeableMovableList(b.getMap('m'), 'k').push('b')

    exchange(a, b)

    expect([...(a.toJSON().m.k as string[])].sort()).toEqual(['a', 'b'])
    expect(a.toJSON().m.k).toEqual(b.toJSON().m.k)
  })
})
