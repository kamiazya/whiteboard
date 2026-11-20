/**
 * The conformance cases for `containerPlace`: which document of a workspace
 * record a container belongs to, where that document is placed, and how long
 * the container is when it is text. A refusal that names only a container id
 * is worded from this answer, so the answers that mean "no document" are held
 * as closely as the ones that name one.
 */
import { describe, expect, it } from 'vitest'
import { MARKDOWN_BODY_KEY, NODES_KEY, THREADS_KEY } from '../containers.js'
import type { CrdtEngine } from '../engine/types.js'
import { documentContainers, WORKSPACE_TREE_KEY } from '../workspace-tree.js'
import { ask, FIRST, held, SECOND, splice, write } from './crdt-engine-conformance-kit.js'

const THIRD = '01J00000000000000000000003'

function placedRecord(engine: CrdtEngine) {
  const { handle } = engine.open({ peer: '5' })
  write(engine, handle, 'createWorkspaceDocumentAtPath', {
    path: 'folder/board',
    documentId: FIRST,
    kind: 'spatial',
  })
  write(engine, handle, 'createWorkspaceDocumentAtPath', {
    path: 'folder/note',
    documentId: SECOND,
    kind: 'markdown',
  })
  // Not an ASCII body, so a length counted in code points or bytes is not the one asked for.
  splice(engine, handle, 0, 0, 'a😀 note', SECOND)
  write(engine, handle, 'writeSpatialNode', {
    documentId: FIRST,
    node: {
      id: 'n1',
      x: 1,
      y: 2,
      width: 100,
      height: 40,
      resource: { mimeType: 'text/markdown', content: 'box' },
    },
  })
  return handle
}

const placeOf = (engine: CrdtEngine, handle: number, container: string) =>
  ask(engine, handle, 'containerPlace', { container })

export function describeContainerPlace(makeEngine: () => CrdtEngine) {
  describe('where the record places a container', () => {
    it('names the document and path a body text sits in, and its length in UTF-16 units', async () => {
      const engine = makeEngine()
      const handle = placedRecord(engine)
      const body = documentContainers(held(engine, handle, 'snapshot'), SECOND).getText(
        MARKDOWN_BODY_KEY,
      )
      expect(await placeOf(engine, handle, body.id)).toEqual({
        ok: { documentId: SECOND, path: 'folder/note', textLength: 'a😀 note'.length },
      })
    })

    it('names the document of a map, with no length', async () => {
      const engine = makeEngine()
      const handle = placedRecord(engine)
      const nodes = documentContainers(held(engine, handle, 'snapshot'), FIRST).getMap(NODES_KEY)
      expect(await placeOf(engine, handle, nodes.id)).toEqual({
        ok: { documentId: FIRST, path: 'folder/board' },
      })
    })

    it('names the document a container opened below its content root belongs to', async () => {
      const engine = makeEngine()
      const handle = placedRecord(engine)
      write(engine, handle, 'writeCommentThread', {
        documentId: SECOND,
        thread: {
          id: 't1',
          anchor: { kind: 'document' },
          status: 'open',
          messages: [{ id: 'm1', body: 'hi' }],
        },
      })
      const threads = documentContainers(held(engine, handle, 'snapshot'), SECOND).getMap(
        THREADS_KEY,
      )
      const thread = threads.get('t1')
      for (const id of [threads.id, (thread as { id: string }).id]) {
        expect(await placeOf(engine, handle, id), id).toEqual({
          ok: { documentId: SECOND, path: 'folder/note' },
        })
      }
    })

    it('answers nothing for a container that is no document of the record', async () => {
      const engine = makeEngine()
      const handle = placedRecord(engine)
      const doc = held(engine, handle, 'snapshot')
      const folder = doc
        .getTree(WORKSPACE_TREE_KEY)
        .getNodes()
        .find(
          (node) =>
            node.data.get('documentId') === undefined && node.data.get('segment') === 'folder',
        )
      const outside = [
        // A root another document keeps its own content under, not the record's tree.
        'cid:root-body:Text',
        doc.getTree(WORKSPACE_TREE_KEY).id,
        // Its creating operation is not in the record, so it has no parent to ask for.
        'cid:99@123:Map',
        'not a container id',
        ...(folder === undefined ? [] : [folder.data.id]),
      ]
      expect(folder, 'the fixture holds a folder').toBeDefined()
      for (const container of outside) {
        expect(await placeOf(engine, handle, container), container).toEqual({ ok: null })
      }
    })

    it('answers nothing for a document the record no longer lists', async () => {
      const engine = makeEngine()
      const handle = placedRecord(engine)
      write(engine, handle, 'createWorkspaceDocumentAtPath', {
        path: 'gone',
        documentId: THIRD,
        kind: 'markdown',
      })
      const body = documentContainers(held(engine, handle, 'snapshot'), THIRD).getText(
        MARKDOWN_BODY_KEY,
      )
      write(engine, handle, 'deleteWorkspaceDocument', { documentId: THIRD })
      expect(await placeOf(engine, handle, body.id)).toEqual({ ok: null })
    })

    it('refuses a question that names no container', async () => {
      const engine = makeEngine()
      const handle = placedRecord(engine)
      expect(await ask(engine, handle, 'containerPlace')).toHaveProperty('err')
    })
  })
}
