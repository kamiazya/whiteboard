/**
 * The content digest is a function of the merged content and of nothing
 * else — held over random canvases and random merge directions, because the
 * example tests can only name the races somebody thought of.
 */
import { spatialCanvasArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect } from 'vitest'
import { writeSpatialCanvas } from './loro-bridge.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  createWorkspaceDocumentAtPath,
  readWorkspaceDocuments,
  writeWorkspaceDocumentContent,
} from './workspace-tree.js'

const ID = '01JQXYZ0000000000000000000'

function contentDoc(canvas: Parameters<typeof writeSpatialCanvas>[1]): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, canvas)
  return doc
}

function digestOf(ws: LoroDoc): string {
  const found = readWorkspaceDocuments(ws).find((e) => e.documentId === ID)
  if (found === undefined) throw new Error('document not listed')
  return found.contentDigest
}

function seeded(peer: bigint, canvas: Parameters<typeof writeSpatialCanvas>[1], stamp: number) {
  const ws = new LoroDoc()
  ws.setPeerId(peer)
  createWorkspaceDocumentAtPath(ws, { path: 'a', documentId: ID, kind: 'spatial' })
  writeWorkspaceDocumentContent(ws, ID, contentDoc(canvas), { updatedAt: stamp })
  return ws
}

describe('contentDigest property', () => {
  fcTest.prop(
    [spatialCanvasArbitrary, fc.integer({ min: 1, max: 1e12 }), fc.integer({ min: 1, max: 1e12 })],
    withDefaults(),
  )(
    'the same content in two unrelated workspaces, at two unrelated stamps, has one digest',
    (canvas, stampA, stampB) => {
      expect(digestOf(seeded(1n, canvas, stampA))).toBe(digestOf(seeded(2n, canvas, stampB)))
    },
  )

  fcTest.prop([spatialCanvasArbitrary, spatialCanvasArbitrary], withDefaults())(
    'two replicas that cross-merged concurrent edits agree on the digest, in either merge order',
    (editA, editB) => {
      const base = seeded(1n, { nodes: [], edges: [] }, 1)
      const snapshot = base.export({ mode: 'snapshot' })
      const a = new LoroDoc()
      a.setPeerId(2n)
      a.import(snapshot)
      const b = new LoroDoc()
      b.setPeerId(3n)
      b.import(snapshot)
      writeWorkspaceDocumentContent(a, ID, contentDoc(editA), { updatedAt: 5000 })
      writeWorkspaceDocumentContent(b, ID, contentDoc(editB), { updatedAt: 2000 })
      const fromA = a.export({ mode: 'update' })
      const fromB = b.export({ mode: 'update' })
      a.import(fromB)
      b.import(fromA)
      expect(digestOf(a)).toBe(digestOf(b))
    },
  )
})
