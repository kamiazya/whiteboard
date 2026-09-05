/**
 * The listing names each document's CONTENT, not the last write's timestamp.
 *
 * The example below is the measurement this exists for, replayed as a
 * regression: two replicas make disjoint edits, exchange updates, and one of
 * them ends up holding content nobody wrote under a stamp that never moved.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { writeSpatialCanvas } from './loro-bridge.js'
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const ID = '01JQXYZ0000000000000000000'
const node = (id: string, text: string, x: number) =>
  ({ id, type: 'text', x, y: 0, width: 100, height: 50, text }) as const

function content(canvas: SpatialCanvas): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc
}

function entry(ws: LoroDoc) {
  const found = readWorkspaceDocuments(ws).find((e) => e.documentId === ID)
  if (found === undefined) throw new Error('document not listed')
  return found
}

function workspaceWith(canvas: SpatialCanvas, updatedAt: number): LoroDoc {
  const ws = new LoroDoc()
  ws.setPeerId(1n)
  createWorkspaceDocumentAtPath(ws, { path: 'a', documentId: ID, kind: 'spatial' })
  writeWorkspaceDocumentContent(ws, ID, content(canvas), { updatedAt })
  return ws
}

describe('readWorkspaceDocuments · contentDigest', () => {
  it('lists a content digest for every document', () => {
    const ws = workspaceWith({ nodes: [node('n0', 'base', 0)], edges: [] }, 1000)
    expect(entry(ws).contentDigest).toMatch(/^[0-9a-f]{16}$/)
  })

  // The defect. On B the stamp is 2000 before and after the merge; the
  // content is not. A key built from the stamp cannot tell these two states
  // apart, and the cached picture of the first is served for the second.
  it('changes on a replica whose merge changed its content but not its updatedAt', () => {
    const base = workspaceWith({ nodes: [node('n0', 'base', 0)], edges: [] }, 1000)
    const snapshot = base.export({ mode: 'snapshot' })
    const a = new LoroDoc()
    a.setPeerId(2n)
    a.import(snapshot)
    const b = new LoroDoc()
    b.setPeerId(3n)
    b.import(snapshot)

    // Disjoint: A adds a node; B edits the base node's text, on a clock that
    // reads earlier.
    writeWorkspaceDocumentContent(
      a,
      ID,
      content({ nodes: [node('n0', 'base', 0), node('n1', 'added-by-A', 300)], edges: [] }),
      { updatedAt: 5000 },
    )
    writeWorkspaceDocumentContent(
      b,
      ID,
      content({ nodes: [node('n0', 'edited-by-B', 0)], edges: [] }),
      { updatedAt: 2000 },
    )
    const before = entry(b)

    b.import(a.export({ mode: 'update' }))
    const after = entry(b)

    // The premise of the defect, pinned so this test cannot pass by the
    // stamp happening to move: it did not.
    expect(after.updatedAt).toBe(before.updatedAt)
    expect(after.contentDigest).not.toBe(before.contentDigest)
  })

  // Two replicas that converged hold one state and must name it once —
  // whichever order their ops arrived in, which is what decides a Loro map's
  // JSON key order.
  it('agrees across replicas that converged from opposite directions', () => {
    const base = workspaceWith({ nodes: [node('n0', 'base', 0)], edges: [] }, 1000)
    const snapshot = base.export({ mode: 'snapshot' })
    const a = new LoroDoc()
    a.setPeerId(2n)
    a.import(snapshot)
    const b = new LoroDoc()
    b.setPeerId(3n)
    b.import(snapshot)
    writeWorkspaceDocumentContent(
      a,
      ID,
      content({ nodes: [node('n0', 'base', 0), node('n1', 'from-A', 300)], edges: [] }),
      { updatedAt: 5000 },
    )
    writeWorkspaceDocumentContent(
      b,
      ID,
      content({ nodes: [node('n0', 'base', 0), node('n2', 'from-B', 600)], edges: [] }),
      { updatedAt: 2000 },
    )
    const fromA = a.export({ mode: 'update' })
    const fromB = b.export({ mode: 'update' })
    a.import(fromB)
    b.import(fromA)

    expect(entry(a).contentDigest).toBe(entry(b).contentDigest)
  })

  // The other half of "names the content": a write that changes nothing must
  // not mint a new identity, or every list refresh would redraw every row.
  it('does not change on a write that changed nothing', () => {
    const canvas: SpatialCanvas = { nodes: [node('n0', 'base', 0)], edges: [] }
    const ws = workspaceWith(canvas, 1000)
    const before = entry(ws).contentDigest
    writeWorkspaceDocumentContent(ws, ID, content(canvas), { updatedAt: 9000 })
    expect(entry(ws).contentDigest).toBe(before)
  })

  it('is a function of the content alone, not of which workspace holds it', () => {
    const canvas: SpatialCanvas = { nodes: [node('n0', 'same', 0)], edges: [] }
    expect(entry(workspaceWith(canvas, 1)).contentDigest).toBe(
      entry(workspaceWith(canvas, 999_999)).contentDigest,
    )
  })
})
