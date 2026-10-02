// The lost update the write lock exists to prevent, demonstrated through
// the REGISTERED handlers over the daemon's real lock: every mutating tool
// is a load-modify-save and `saveSnapshot` writes unconditionally, so two
// calls that load the same base before either saves drop one of the
// changes. The lock is the tool's own (server-core's `write-lock.test.ts`
// pins that each takes it); what this file pins is that the daemon's
// `LiveDocuments` seam hands the tools a lock that really queues.

import { writeSpatialCanvas as _w, readSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentIndex, InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { LoroDoc } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDocumentTools } from '../mcp/document-tools.js'
import { liveDocuments } from './live-documents.js'
import { _resetWorkspaceLocksForTests } from './workspace-lock.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

const CANVAS: SpatialCanvas = {
  nodes: [
    textNode({ id: 'n1', x: 0, y: 0, width: 100, height: 50, text: 'a' }),
    textNode({ id: 'n2', x: 200, y: 0, width: 100, height: 50, text: 'b' }),
  ],
  edges: [],
}

async function makeDeps() {
  const documentStore = new InMemoryDocumentStore()

  // The patch tools assert the canvas belongs to the workspace, so the
  // index has to name it before any of them will run.
  const documentIndex = new InMemoryDocumentIndex()
  documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    path: 'doc',
    kind: 'spatial',
  })

  const seedDoc = new LoroDoc()
  _w(seedDoc, CANVAS)
  const { manifest, chunks } = chunkSnapshot(seedDoc.export({ mode: 'snapshot' }), 1_000_000)
  await documentStore.saveSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
    manifest,
    chunks,
    frontier: seedDoc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
  return {
    documentStore,
    blobStore: {} as never,
    documentIndex,
    // The daemon's own seam, so the tools take the daemon's own lock.
    liveDocuments: liveDocuments(),
  }
}

/** The canvas as actually stored, after everything settles. */
async function storedCanvas(deps: Awaited<ReturnType<typeof makeDeps>>) {
  const stored = await deps.documentStore.loadSnapshot({
    docRef: { kind: 'document', workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
  })
  if (stored === null) throw new Error('no snapshot')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(stored.manifest, stored.chunks))
  return readSpatialCanvas(doc)
}

/** Positions of both nodes as actually stored. */
async function storedPositions(deps: Awaited<ReturnType<typeof makeDeps>>) {
  const { nodes } = await storedCanvas(deps)
  return Object.fromEntries(nodes.map((node) => [node.id, node.x]))
}

beforeEach(() => {
  _resetWorkspaceLocksForTests()
})

describe('registered MCP handlers', () => {
  function registeredHandlers(deps: Awaited<ReturnType<typeof makeDeps>>) {
    const registerTool = vi.fn()
    registerDocumentTools({ registerTool } as never, deps as never)
    const byName = new Map<string, (args: unknown, extra: unknown) => Promise<unknown>>()
    for (const call of registerTool.mock.calls) {
      byName.set(call[0] as string, call[2] as never)
    }
    return byName
  }

  it('serializes two mutating handlers on the same canvas', async () => {
    const deps = await makeDeps()
    // A barrier cannot be used here: once the calls ARE serialized the
    // second one never loads until the first finishes, so waiting for both
    // to arrive deadlocks. Record the store traffic instead and assert the
    // shape directly — interleaved load/load/save/save is the lost update,
    // load/save/load/save is the fix.
    const events: string[] = []
    const load = deps.documentStore.loadSnapshot.bind(deps.documentStore)
    const save = deps.documentStore.saveSnapshot.bind(deps.documentStore)
    deps.documentStore.loadSnapshot = async (input) => {
      if (input.docRef.kind === 'document') events.push('load')
      return load(input)
    }
    deps.documentStore.saveSnapshot = async (input) => {
      if (input.docRef.kind === 'document') events.push('save')
      return save(input)
    }

    const handlers = registeredHandlers(deps)
    const canvasEdit = handlers.get('wb_canvas_edit')!
    await Promise.all([
      canvasEdit(
        {
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          mode: 'apply',
          ops: [{ op: 'node.patch', id: 'n1', patch: { x: 11 } }],
        },
        {},
      ),
      canvasEdit(
        {
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          mode: 'apply',
          ops: [{ op: 'node.patch', id: 'n2', patch: { x: 22 } }],
        },
        {},
      ),
    ])

    // The exact event count is an implementation detail; the property is
    // that the second call never reads a base the first had not yet written.
    const firstSave = events.indexOf('save')
    const secondLoad = events.indexOf('load', events.indexOf('load') + 1)
    expect(firstSave, `store traffic was ${events.join(',')}`).toBeGreaterThan(-1)
    expect(secondLoad, `store traffic was ${events.join(',')}`).toBeGreaterThan(firstSave)
    expect(await storedPositions(deps)).toEqual({ n1: 11, n2: 22 })
  })

  it('does not queue a READ-ONLY handler behind a held write', async () => {
    const deps = await makeDeps()
    const handlers = registeredHandlers(deps)

    // Hold the write inside its critical section, then check a read still
    // completes. Serializing reads behind writes would make a render wait
    // on an unrelated patch for no correctness gain.
    let releaseWrite!: () => void
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    const save = deps.documentStore.saveSnapshot.bind(deps.documentStore)
    deps.documentStore.saveSnapshot = async (input) => {
      if (input.docRef.kind === 'document') await writeHeld
      return save(input)
    }

    const writing = handlers.get('wb_canvas_edit')!(
      {
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [{ op: 'node.patch', id: 'n1', patch: { x: 11 } }],
      },
      {},
    )
    const read = await handlers.get('wb_canvas_snapshot')!(
      { workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID },
      {},
    )
    expect(read).toBeDefined()

    releaseWrite()
    await writing
  })
})
