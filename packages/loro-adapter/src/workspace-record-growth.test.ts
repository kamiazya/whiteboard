/**
 * The workspace-record growth SCOREBOARD (measured-change instrument for
 * the history-GC design): one Loro document accumulates every edit of every
 * document in a workspace, and these numbers are what any retention/GC
 * decision is judged against.
 *
 * Byte counts are pinned EXACTLY, not as ceilings — an improvement must be
 * as loud as a regression, and a loro-crdt upgrade that changes the
 * encoding shows up here as a number somebody explains. Deterministic
 * because the peer id is fixed and Loro records no wall-clock by default;
 * the determinism test below is what turns that assumption into a fact.
 *
 * What the numbers said when first taken (2026-08-26):
 * - an empty document costs ~250-860B of record (858B for the first, ~250B
 *   marginal: 10 docs = 3002B, 50 docs = 12655B).
 * - a full one-node canvas rewrite ships ~178B of incremental update
 *   (178460B over 1000 edits), but the SNAPSHOT encoding compresses that
 *   history well: the full snapshot after those 1000 edits is 11348B, not
 *   178KB — history in the stored record costs ~8B/edit, while the delta
 *   LOG (what accumulates between compactions) costs the full ~178B/edit.
 * - the shallow snapshot at the current frontier collapses 1000 edits back
 *   to exactly the create-time size (3002B) — the reclaim IS the GC story,
 *   and version retention plus branch tips bound how much of it compaction
 *   may take.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeSpatialCanvas } from './loro-bridge.js'
import { createWorkspaceDocumentAtPath, documentContainers } from './workspace-tree.js'

interface GrowthNumbers {
  afterCreateBytes: number
  updateBytes: number
  fullBytes: number
  shallowBytes: number
}

function build(docCount: number, editsPerDoc: number): GrowthNumbers {
  const ws = new LoroDoc()
  ws.setPeerId(1n)
  const ids: string[] = []
  for (let d = 0; d < docCount; d++) {
    const entry = createWorkspaceDocumentAtPath(ws, {
      path: `docs/d${d}`,
      documentId: `01ARZ3NDEKTSV4RRFFQ69G5F${String(d).padStart(2, '0')}`,
      kind: 'spatial',
      createdAt: 1000,
      updatedAt: 1000,
    })
    if (entry === null) throw new Error('fixture path collided')
    ids.push(entry.documentId)
  }
  ws.commit()
  const afterCreateBytes = ws.export({ mode: 'snapshot' }).byteLength
  let updateBytes = 0
  for (let d = 0; d < docCount; d++) {
    const id = ids[d] as string
    for (let e = 0; e < editsPerDoc; e++) {
      const from = ws.oplogVersion()
      writeSpatialCanvas(documentContainers(ws, id), {
        nodes: [
          { id: 'n1', type: 'text', x: e, y: 0, width: 80, height: 40, text: `edit ${e} of ${d}` },
        ],
        edges: [],
      })
      ws.commit()
      updateBytes += ws.export({ mode: 'update', from }).byteLength
    }
  }
  return {
    afterCreateBytes,
    updateBytes,
    fullBytes: ws.export({ mode: 'snapshot' }).byteLength,
    shallowBytes: ws.export({ mode: 'shallow-snapshot', frontiers: ws.frontiers() }).byteLength,
  }
}

describe('workspace-record growth scoreboard', () => {
  it('is deterministic — same ops, same peer, same bytes', () => {
    expect(build(3, 20)).toEqual(build(3, 20))
  })

  it('pins record size against document count (no edits)', () => {
    // Each pre-attached container costs a document ~16-30B here. The last
    // move was the annotation layer's `threads` map (ADR-0026) joining
    // `CONTENT_CONTAINER_KEYS`: 889 -> 919 at one document, 13866 -> 14860 at
    // fifty. That is the price of pre-attaching — a container attached on
    // first READ instead would cost nothing here and clear the UndoManager's
    // redo stack, which is the trade the pre-attached set exists to refuse.
    expect(build(1, 0).afterCreateBytes).toBe(919)
    expect(build(10, 0).afterCreateBytes).toBe(3329)
    expect(build(50, 0).afterCreateBytes).toBe(14860)
  })

  it('pins oplog growth per edit and the shallow reclaim', () => {
    const n = build(10, 100)
    // The delta LOG price of an edit — what accumulates between compactions.
    expect(n.updateBytes).toBe(178560)
    // The stored-snapshot price of the same history — Loro's snapshot
    // encoding compresses it to ~8B/edit.
    expect(n.fullBytes).toBe(11563)
    // The reclaim: a shallow cut at the current frontier collapses the whole
    // edit history. It is no longer byte-IDENTICAL to the create-time record:
    // since the comments container (ADR-0024) joined the pre-attached set, a
    // container that has never been written encodes leaner in a shallow
    // snapshot than at create time (measured 3302 vs 3329, and the gap grows
    // with each such container — 9B when comments was the only one), so the cut is
    // pinned exactly AND bounded by the create-time size — the reclaim story
    // ("compaction takes back everything the edits added") is the invariant,
    // byte identity was only its strongest available form.
    expect(n.shallowBytes).toBe(3302)
    expect(n.shallowBytes).toBeLessThanOrEqual(build(10, 0).afterCreateBytes)
  })
})
