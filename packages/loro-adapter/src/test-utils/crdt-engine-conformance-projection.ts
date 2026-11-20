/**
 * The conformance cases for the projection export: one document of a workspace
 * record answered as bytes that open to a document whose root containers are
 * that document's content.
 */
import { bytesToBase64, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { LoroMap } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import type { CrdtEngine } from '../engine/types.js'
import { WORKSPACE_TREE_KEY } from '../workspace-tree.js'
import { applied, ask, FIRST, held, jsonOf, SECOND, write } from './crdt-engine-conformance-kit.js'

const THIRD = '01J00000000000000000000003'
const FOLDER_ONLY = '01J00000000000000000000004'

const THREAD = {
  id: 'thread-1',
  anchor: { kind: 'canvas', x: 1, y: 2 },
  status: 'open',
  messages: [{ id: 'm1', authorId: 'a', body: 'hello', createdAt: 1 }],
  createdAt: 1,
}

/** A record holding a spatial document with a facet and a markdown one with a body. */
function projectionRecord(engine: CrdtEngine) {
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
  write(engine, handle, 'writeSpatialNode', {
    documentId: FIRST,
    node: {
      id: 'n1',
      resource: { mimeType: 'text/markdown', content: 'box' },
      x: 1,
      y: 2,
      width: 100,
      height: 40,
    },
  })
  write(engine, handle, 'writeFacets', {
    documentId: FIRST,
    facets: { 'visual.test/v1': { tone: 'warm' } },
  })
  write(engine, handle, 'spliceText', {
    documentId: SECOND,
    text: 'body',
    runs: [{ index: 0, remove: 0, insert: 'a note body' }],
  })
  write(engine, handle, 'writeCommentThread', { documentId: SECOND, thread: THREAD })
  return handle
}

const projectionOf = (engine: CrdtEngine, handle: number, documentId: string) =>
  wire.exportResponseSchema.parse(engine.export({ handle, mode: 'projection', documentId }))

export function describeProjectionExport(makeEngine: () => CrdtEngine) {
  describe('an export of one document as a standalone projection', () => {
    it.each([FIRST, SECOND])('opens to the content the record reads for %s', async (id) => {
      const engine = makeEngine()
      const record = projectionRecord(engine)
      const { bytes } = projectionOf(engine, record, id)
      expect(bytes).toBeDefined()
      const opened = engine.open({ peer: '9', bytes: bytes as string })
      const own = (await ask(engine, record, 'documentContent', { documentId: id })) as {
        ok: unknown
      }
      expect(own.ok).toBeDefined()
      expect(await ask(engine, opened.handle, 'documentContent')).toEqual({ ok: own.ok })
    })

    it('carries the document own facets and threads at root containers', () => {
      const engine = makeEngine()
      const record = projectionRecord(engine)
      const board = held(
        engine,
        engine.open({
          peer: '9',
          bytes: projectionOf(engine, record, FIRST).bytes as string,
        }).handle,
        'snapshot',
      )
      expect(jsonOf(board.toJSON())).toMatchObject({
        facets: { 'visual.test/v1': { tone: 'warm' } },
      })
      const note = held(
        engine,
        engine.open({
          peer: '9',
          bytes: projectionOf(engine, record, SECOND).bytes as string,
        }).handle,
        'snapshot',
      )
      expect(jsonOf(note.toJSON())).toMatchObject({
        body: 'a note body',
        threads: { 'thread-1': { status: 'open' } },
      })
    })

    it('keeps the other documents of the record out of the projection', () => {
      const engine = makeEngine()
      const record = projectionRecord(engine)
      const note = held(
        engine,
        engine.open({
          peer: '9',
          bytes: projectionOf(engine, record, SECOND).bytes as string,
        }).handle,
        'snapshot',
      )
      expect(JSON.stringify(note.toJSON())).not.toContain('box')
    })

    it('skips a record-internal plane key and the document scalar meta', () => {
      const engine = makeEngine()
      const record = projectionRecord(engine)
      const stored = held(engine, record, 'snapshot')
      const node = stored
        .getTree(WORKSPACE_TREE_KEY)
        .getNodes()
        .find((candidate) => candidate.data.get('documentId') === SECOND)
      node?.data.setContainer('plane:branches', new LoroMap()).set('draft', { tip: 'AQID' })
      stored.commit()
      const planted = engine.open({
        peer: '6',
        bytes: bytesToBase64(stored.export({ mode: 'snapshot' })),
      })
      const note = held(
        engine,
        engine.open({
          peer: '9',
          bytes: projectionOf(engine, planted.handle, SECOND).bytes as string,
        }).handle,
        'snapshot',
      )
      const json = jsonOf(note.toJSON()) as Record<string, unknown>
      expect(Object.keys(json).filter((key) => key.startsWith('plane:'))).toEqual([])
      expect(json).not.toHaveProperty('documentId')
      expect(json).not.toHaveProperty('segment')
      expect(json).toHaveProperty('body', 'a note body')
    })

    it('answers no bytes for an unknown id, a folder segment and a deleted document', () => {
      const engine = makeEngine()
      const record = projectionRecord(engine)
      expect(projectionOf(engine, record, THIRD)).toEqual({})
      expect(projectionOf(engine, record, FOLDER_ONLY)).toEqual({})
      applied(
        engine.write(
          wire.writeRequestSchema.parse({
            handle: record,
            batch: [{ op: 'deleteWorkspaceDocument', args: { documentId: SECOND } }],
          }),
        ),
      )
      expect(projectionOf(engine, record, SECOND)).toEqual({})
      expect(projectionOf(engine, record, FIRST).bytes).toBeDefined()
    })
  })
}
