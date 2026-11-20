/**
 * What a keeper pays to learn which documents one small write touched.
 * `exportJsonUpdates` between two versions costs by how many peers the record
 * has seen, not by what was written, and a record opened under a new peer each
 * time has seen as many peers as it has been opened. Reading the written span
 * of each peer costs by the write.
 */
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { documentsTouchedSince, organisationChangedSince } from './touched-documents.js'
import { createWorkspaceDocumentAtPath } from './workspace-tree.js'

const PEERS = 300

/** A record each of whose documents was added by a different peer, then one more write on top. */
function recordOfManyPeers() {
  let snapshot: Uint8Array | null = null
  let doc = new LoroDoc()
  for (let i = 0; i <= PEERS; i++) {
    doc = new LoroDoc()
    if (snapshot !== null) doc.import(snapshot)
    if (i === PEERS) break
    createWorkspaceDocumentAtPath(doc, {
      path: `doc-${i}`,
      documentId: `01J000000000000000000${String(i).padStart(5, '0')}`,
      kind: 'markdown',
    })
    snapshot = doc.export({ mode: 'snapshot' })
  }
  const since = doc.oplogVersion()
  createWorkspaceDocumentAtPath(doc, {
    path: 'latest',
    documentId: '01J0000000000000000FRESH00',
    kind: 'markdown',
  })
  return { doc, since }
}

/** The fastest of several runs, so a collection in one of them does not decide. */
function fastest(run: () => unknown): number {
  let best = Number.POSITIVE_INFINITY
  for (let rep = 0; rep < 7; rep++) {
    const started = performance.now()
    run()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

describe('reading what a write touched, on a record of many peers', () => {
  const { doc, since } = recordOfManyPeers()
  const head = doc.oplogVersion()
  const wholeRange = fastest(() => doc.exportJsonUpdates(since, head, false))

  it('finds the document the write created', () => {
    expect(documentsTouchedSince(doc, since).map((each) => each.path)).toEqual(['latest'])
  })

  it('costs well under a read of the whole range', () => {
    expect(fastest(() => documentsTouchedSince(doc, since))).toBeLessThan(wholeRange / 3)
  })

  it('judges whether the organisation changed at the same low cost', () => {
    expect(organisationChangedSince(doc, since)).toBe(true)
    expect(fastest(() => organisationChangedSince(doc, since))).toBeLessThan(wholeRange / 3)
  })
})
