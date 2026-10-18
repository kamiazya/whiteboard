/**
 * The per-canvas node and edge ceilings on the editor's sync writes.
 *
 * `wb_canvas_edit` refuses the op that would take a board past
 * `CANVAS_MAX_NODES` or `CANVAS_MAX_EDGES_AND_LINES`; a sync write carries Loro bytes no
 * op reads, so the same bound is judged against what the bytes do. The double
 * keeps a stored snapshot beside its cached instance, so "nothing was kept" is
 * observable as what the next read finds.
 */
import {
  deleteSpatialNode,
  readSpatialCanvas,
  writeSpatialCanvas,
  writeSpatialNode,
} from '@kamiazya/whiteboard-loro-adapter'
import { CANVAS_MAX_NODES } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { LiveDocuments } from '../server-deps.js'
import { StoredDoc } from '../test-utils/stored-doc.js'
import { unusedLiveDocuments } from '../test-utils/unused-live-documents.js'
import { applyDocumentUpdate } from './apply-document-update.js'
import { syncWriteAnswer } from './sync-write-refusals.js'

const box = (id: string) => textNode({ id, x: 0, y: 0, width: 100, height: 40, text: id })

function boardOf(nodes: number): LoroDoc {
  const doc = new LoroDoc()
  writeSpatialCanvas(doc, {
    nodes: Array.from({ length: nodes }, (_, i) => box(`n${i}`)),
    edges: [],
  })
  return doc
}

function send(store: StoredDoc, edit: (doc: LoroDoc) => void) {
  const liveDocuments: LiveDocuments = {
    ...unusedLiveDocuments(),
    withWriteLock: (_workspaceId, fn) => fn(),
    get: async () => store.get(),
    save: async (_workspaceId, _path, doc) => store.save(doc),
    evict: () => store.evict(),
  }
  const client = store.get().fork()
  const from = client.oplogVersion()
  edit(client)
  client.commit()
  return applyDocumentUpdate(
    { liveDocuments },
    { workspaceId: 'ws-1', path: 'board', update: client.export({ mode: 'update', from }) },
  )
}

describe('a document sync update', () => {
  it('adding a node past the per-canvas ceiling is refused, 413, and nothing is kept', async () => {
    const store = new StoredDoc(boardOf(CANVAS_MAX_NODES))

    const refusal = await send(store, (doc) => writeSpatialNode(doc, box('extra'))).catch(
      (err: unknown) => err,
    )

    expect(refusal).toMatchObject({ name: 'CanvasTooLargeError' })
    expect(refusal).toMatchObject({ breach: { measure: 'nodes', count: CANVAS_MAX_NODES + 1 } })
    expect(syncWriteAnswer(refusal)).toEqual({ code: 'too_many_nodes_or_edges', status: 413 })
    expect(store.saves).toBe(0)
    expect(readSpatialCanvas(store.get()).nodes).toHaveLength(CANVAS_MAX_NODES)
  })

  it('replacing a node on a board stored past the ceiling is applied', async () => {
    const store = new StoredDoc(boardOf(CANVAS_MAX_NODES + 3))

    await send(store, (doc) => {
      deleteSpatialNode(doc, 'n0')
      writeSpatialNode(doc, box('replacement'))
    })

    const ids = readSpatialCanvas(store.get()).nodes.map((node) => node.id)
    expect(ids).toHaveLength(CANVAS_MAX_NODES + 3)
    expect(ids).toContain('replacement')
  })
})
