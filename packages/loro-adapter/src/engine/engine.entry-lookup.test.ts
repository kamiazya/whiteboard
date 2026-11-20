import { bytesToBase64, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { LoroDoc, LoroTree } from 'loro-crdt'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWorkspaceDocumentAtPath,
  exportWorkspaceSubtree,
  resolveWorkspaceDocumentById,
} from '../workspace-tree.js'
import { createCrdtEngine } from './engine.js'

/**
 * Finding one document of a workspace record by its id. A listing asks it once
 * per document, so a lookup that walks the whole tree makes a listing quadratic
 * in the workspace; the engine keeps the ids it found for the state they were
 * found in, and every way that state changes has to be seen by it.
 */
const idOf = (n: number) => `01J00000000000000000000${String(n).padStart(3, '0')}`
const COUNT = 40

type Engine = ReturnType<typeof createCrdtEngine>

function record(count = COUNT): Uint8Array {
  const doc = new LoroDoc()
  for (let i = 0; i < count; i++) {
    createWorkspaceDocumentAtPath(doc, {
      path: `folder/doc-${i}`,
      documentId: idOf(i),
      kind: 'markdown',
    })
  }
  doc.commit()
  return doc.export({ mode: 'snapshot' })
}

function opened(engine: Engine, peer = '1'): number {
  return engine.open({ peer, bytes: bytesToBase64(record()) }).handle
}

const entryOf = (engine: Engine, handle: number, n: number) =>
  (
    engine.readNow({
      handle,
      query: { query: 'workspaceDocumentEntry', args: { documentId: idOf(n) } },
    }) as { value: { ok: { path: string } | null } }
  ).value.ok

const pathOf = (engine: Engine, handle: number, n: number) =>
  entryOf(engine, handle, n)?.path ?? null

const write = (engine: Engine, handle: number, batch: unknown[]) =>
  engine.write(wire.writeRequestSchema.parse({ handle, batch, judge: 'none' }))

const create = (n: number, path = `fresh/doc-${n}`) => ({
  op: 'createWorkspaceDocumentAtPath',
  args: { path, documentId: idOf(n), kind: 'markdown' },
})

describe('finding a workspace document by its id', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('walks the tree once for every lookup of a state, not once per lookup', () => {
    const engine = createCrdtEngine()
    const handle = opened(engine)
    const roots = vi.spyOn(LoroTree.prototype, 'roots')
    for (let n = 0; n < COUNT; n++) expect(pathOf(engine, handle, n)).toBe(`folder/doc-${n}`)
    expect(roots.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('answers null for an id the record does not hold', () => {
    const engine = createCrdtEngine()
    const handle = opened(engine)
    expect(pathOf(engine, handle, COUNT + 5)).toBeNull()
  })

  it('finds the same one of two documents that concurrently took an id as a walk does', () => {
    const base = new LoroDoc()
    base.setPeerId(1)
    const left = new LoroDoc()
    left.setPeerId(2)
    const right = new LoroDoc()
    right.setPeerId(3)
    for (const [replica, path] of [
      [left, 'left'],
      [right, 'right'],
    ] as const) {
      replica.import(base.export({ mode: 'snapshot' }))
      createWorkspaceDocumentAtPath(replica, { path, documentId: idOf(0), kind: 'markdown' })
      replica.commit()
    }
    left.import(right.export({ mode: 'update' }))
    const engine = createCrdtEngine()
    const handle = engine.open({
      peer: '9',
      bytes: bytesToBase64(left.export({ mode: 'snapshot' })),
    }).handle
    const walked = resolveWorkspaceDocumentById(left, idOf(0))?.path
    expect(['left', 'right']).toContain(walked)
    expect(pathOf(engine, handle, 0)).toBe(walked)
  })

  describe('after each way the record changes', () => {
    it('sees a document a write created, moved and deleted', () => {
      const engine = createCrdtEngine()
      const handle = opened(engine)
      expect(pathOf(engine, handle, COUNT)).toBeNull()
      write(engine, handle, [create(COUNT)])
      expect(pathOf(engine, handle, COUNT)).toBe(`fresh/doc-${COUNT}`)
      write(engine, handle, [
        {
          op: 'moveWorkspaceNodeToPath',
          args: { from: `fresh/doc-${COUNT}`, to: 'elsewhere/moved' },
        },
      ])
      expect(pathOf(engine, handle, COUNT)).toBe('elsewhere/moved')
      write(engine, handle, [
        { op: 'deleteWorkspaceNodeAtPath', args: { path: 'elsewhere/moved' } },
      ])
      expect(pathOf(engine, handle, COUNT)).toBeNull()
    })

    it('sees a document an import brought', () => {
      const engine = createCrdtEngine()
      const handle = opened(engine)
      expect(pathOf(engine, handle, COUNT)).toBeNull()
      const replica = new LoroDoc()
      replica.import(Buffer.from(engine.export({ handle, mode: 'snapshot' }).bytes ?? '', 'base64'))
      createWorkspaceDocumentAtPath(replica, {
        path: 'imported',
        documentId: idOf(COUNT),
        kind: 'markdown',
      })
      replica.commit()
      const update = bytesToBase64(replica.export({ mode: 'update' }))
      expect(engine.import({ handle, bytes: update, judge: 'none' }).outcome).toBe('applied')
      expect(pathOf(engine, handle, COUNT)).toBe('imported')
    })

    it('sees a document a subtree import placed', () => {
      const engine = createCrdtEngine()
      const handle = opened(engine)
      const source = new LoroDoc()
      createWorkspaceDocumentAtPath(source, {
        path: 'kept',
        documentId: idOf(COUNT),
        kind: 'markdown',
      })
      source.commit()
      const bytes = exportWorkspaceSubtree(source, 'kept')
      if (bytes === null) throw new Error('the fixture holds no such document')
      expect(pathOf(engine, handle, COUNT)).toBeNull()
      engine.importSubtree({
        handle,
        bytes: bytesToBase64(bytes),
        parentPath: 'placed',
        judge: 'none',
      })
      expect(pathOf(engine, handle, COUNT)).toBe('placed/kept')
    })

    it('sees an undo and a redo of a creation', () => {
      const engine = createCrdtEngine()
      const handle = opened(engine)
      write(engine, handle, [create(COUNT)])
      expect(pathOf(engine, handle, COUNT)).toBe(`fresh/doc-${COUNT}`)
      engine.undo({ handle, judge: 'none' })
      expect(pathOf(engine, handle, COUNT)).toBeNull()
      engine.redo({ handle, judge: 'none' })
      expect(pathOf(engine, handle, COUNT)).toBe(`fresh/doc-${COUNT}`)
    })

    it('sees nothing of a write that threw after part of it applied', () => {
      const engine = createCrdtEngine()
      const handle = opened(engine)
      expect(pathOf(engine, handle, COUNT)).toBeNull()
      const failing = [
        create(COUNT),
        {
          op: 'createWorkspaceDocumentAtPath',
          args: { path: 'bad', documentId: 'not an id', kind: 'markdown' },
        },
      ]
      expect(() => write(engine, handle, failing)).toThrow()
      expect(pathOf(engine, handle, COUNT)).toBeNull()
      expect(pathOf(engine, handle, 0)).toBe('folder/doc-0')
    })

    it('answers a view at the state the view is at, and again after the view moves', () => {
      const engine = createCrdtEngine()
      const handle = opened(engine)
      const earlier = engine.version({ handle }).frontiers
      write(engine, handle, [create(COUNT)])
      const later = engine.version({ handle }).frontiers
      const view = engine.fork({ handle, peer: '2', at: earlier }).handle
      expect(pathOf(engine, view, COUNT)).toBeNull()
      engine.checkout({ handle: view, at: later })
      expect(pathOf(engine, view, COUNT)).toBe(`fresh/doc-${COUNT}`)
      engine.checkout({ handle: view, at: earlier })
      expect(pathOf(engine, view, COUNT)).toBeNull()
    })

    it('keeps a fork and the document it was made from each to their own record', () => {
      const engine = createCrdtEngine()
      const handle = opened(engine)
      const copy = engine.fork({ handle, peer: '2' }).handle
      expect(pathOf(engine, copy, 0)).toBe('folder/doc-0')
      write(engine, copy, [create(COUNT)])
      expect(pathOf(engine, copy, COUNT)).toBe(`fresh/doc-${COUNT}`)
      expect(pathOf(engine, handle, COUNT)).toBeNull()
      write(engine, handle, [create(COUNT + 1)])
      expect(pathOf(engine, copy, COUNT + 1)).toBeNull()
    })
  })
})
