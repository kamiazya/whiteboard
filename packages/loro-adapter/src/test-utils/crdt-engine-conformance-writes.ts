/**
 * The conformance cases for a write the host does not want judged by the
 * engine, a text splice a batch carries, the index writes of a workspace
 * record, and an export of the subtree at a path.
 */
import { MARKDOWN_MAX_CHARS, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { CrdtEngine } from '../engine/types.js'
import { importWorkspaceSubtree } from '../workspace-tree.js'
import {
  applied,
  ask,
  bodyOf,
  bytesOf,
  FIRST,
  held,
  mutation,
  openWith,
  SECOND,
  write,
} from './crdt-engine-conformance-kit.js'

/** Opens with every commit its own undo step, so an undo takes back one call. */
function openApart(engine: CrdtEngine, body: string) {
  const { handle } = engine.open({ peer: '1', undoMergeIntervalMs: 0 })
  write(engine, handle, 'writeMarkdownBody', { body })
  return handle
}

const OVERSIZE = 'x'.repeat(MARKDOWN_MAX_CHARS + 1)

const oversizeBody = (judge?: 'text' | 'none') =>
  wire.writeRequestSchema.parse({
    handle: 0,
    batch: [{ op: 'writeMarkdownBody', args: { body: OVERSIZE } }],
    ...(judge === undefined ? {} : { judge }),
  })

export function describeWriteJudging(makeEngine: () => CrdtEngine) {
  describe('a write the host does not have judged', () => {
    it('applies with none a write that the text limits refuse', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'kept')
      expect(mutation(engine.write({ ...oversizeBody(), handle }))).toMatchObject({
        outcome: 'refused',
      })
      expect(mutation(engine.write({ ...oversizeBody('text'), handle }))).toMatchObject({
        outcome: 'refused',
      })
      expect(await bodyOf(engine, handle)).toBe('kept')
      const result = applied(engine.write({ ...oversizeBody('none'), handle }))
      expect(result.localUpdate).toBeDefined()
      expect((await bodyOf(engine, handle)).length).toBe(MARKDOWN_MAX_CHARS + 1)
    }, 30_000)

    it('judges a later text write against the document a none write left', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'one')
      applied(
        engine.write(
          wire.writeRequestSchema.parse({
            handle,
            batch: [{ op: 'writeMarkdownBody', args: { body: 'two' } }],
            judge: 'none',
          }),
        ),
      )
      expect(mutation(engine.write({ ...oversizeBody(), handle }))).toMatchObject({
        outcome: 'refused',
      })
      expect(await bodyOf(engine, handle)).toBe('two')
      write(engine, handle, 'writeMarkdownBody', { body: 'three' })
      expect(await bodyOf(engine, handle)).toBe('three')
    }, 30_000)
  })
}

export function describeUndoJudging(makeEngine: () => CrdtEngine) {
  describe('an undo and a redo the host does not have judged', () => {
    it('undoes with none what undoing under the text limits refuses', async () => {
      const undone = async (judge: 'text' | 'none') => {
        const engine = makeEngine()
        const handle = openApart(engine, 'kept')
        for (const body of [OVERSIZE, 'small']) {
          const batch = [{ op: 'writeMarkdownBody', args: { body } }]
          applied(engine.write(wire.writeRequestSchema.parse({ handle, batch, judge: 'none' })))
        }
        return {
          result: mutation(engine.undo({ handle, judge })),
          body: await bodyOf(engine, handle),
        }
      }
      const refused = await undone('text')
      expect(refused.result).toMatchObject({ outcome: 'refused' })
      expect(refused.body).toBe('small')
      const accepted = await undone('none')
      expect(accepted.result.outcome).toBe('applied')
      expect(accepted.body.length).toBe(MARKDOWN_MAX_CHARS + 1)
    }, 30_000)

    it('redoes with none what redoing under the text limits refuses', async () => {
      const redone = async (judge: 'text' | 'none') => {
        const engine = makeEngine()
        const handle = openApart(engine, 'kept')
        applied(
          engine.textSplice({
            handle,
            text: 'body',
            runs: [{ index: 4, remove: 0, insert: OVERSIZE }],
            judge: 'none',
          }),
        )
        applied(engine.undo({ handle, judge: 'none' }))
        return {
          result: mutation(engine.redo({ handle, judge })),
          body: await bodyOf(engine, handle),
        }
      }
      const refused = await redone('text')
      expect(refused.result).toMatchObject({ outcome: 'refused' })
      expect(refused.body).toBe('kept')
      const accepted = await redone('none')
      expect(accepted.result.outcome).toBe('applied')
      expect(accepted.body.length).toBe(4 + MARKDOWN_MAX_CHARS + 1)
    }, 30_000)
  })
}

export function describeSpliceJudging(makeEngine: () => CrdtEngine) {
  describe('a splice and a placed subtree the host does not have judged', () => {
    it('applies a splice and an undo with none that the text limits refuse', async () => {
      const engine = makeEngine()
      const handle = openApart(engine, 'kept')
      const splice = (judge?: 'text' | 'none') =>
        engine.textSplice(
          wire.textSpliceRequestSchema.parse({
            handle,
            text: 'body',
            runs: [{ index: 4, remove: 0, insert: OVERSIZE }],
            ...(judge === undefined ? {} : { judge }),
          }),
        )
      expect(mutation(splice())).toMatchObject({ outcome: 'refused' })
      applied(splice('none'))
      expect((await bodyOf(engine, handle)).length).toBe(4 + MARKDOWN_MAX_CHARS + 1)
      applied(engine.undo({ handle, judge: 'none' }))
      expect(await bodyOf(engine, handle)).toBe('kept')
    }, 30_000)

    it('places with none a subtree whose body the text limits refuse', async () => {
      const engine = makeEngine()
      const { handle: from } = engine.open({ peer: '3' })
      write(engine, from, 'createWorkspaceDocumentAtPath', {
        path: 'notes/big',
        documentId: FIRST,
        kind: 'markdown',
      })
      applied(
        engine.textSplice({
          handle: from,
          documentId: FIRST,
          text: 'body',
          runs: [{ index: 0, remove: 0, insert: OVERSIZE }],
          judge: 'none',
        }),
      )
      const bytes = engine.export({ handle: from, mode: 'subtree', path: 'notes/big' }).bytes
      if (bytes === undefined) throw new Error('the fixture holds no such document')
      const { handle } = engine.open({ peer: '1' })
      expect(mutation(engine.importSubtree({ handle, bytes }))).toMatchObject({
        outcome: 'refused',
      })
      applied(engine.importSubtree({ handle, bytes, judge: 'none' }))
      expect((await bodyOf(engine, handle, FIRST)).length).toBe(MARKDOWN_MAX_CHARS + 1)
    }, 30_000)
  })
}

export function describeWriteJudgingThrow(makeEngine: () => CrdtEngine) {
  describe('a write that throws under none', () => {
    it('leaves the document as it was when a writer throws under none, and writes on', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'kept')
      const batch = [
        { op: 'writeMarkdownBody', args: { body: 'lost' } },
        { op: 'createWorkspaceDocument', args: { segment: 'no id' } },
      ]
      expect(() =>
        engine.write(wire.writeRequestSchema.parse({ handle, batch, judge: 'none' })),
      ).toThrow()
      expect(await bodyOf(engine, handle)).toBe('kept')
      applied(
        engine.write(
          wire.writeRequestSchema.parse({
            handle,
            batch: [{ op: 'writeMarkdownBody', args: { body: 'after' } }],
            judge: 'none',
          }),
        ),
      )
      expect(await bodyOf(engine, handle)).toBe('after')
    })
  })
}

export function describeJudgeVocabulary() {
  describe('the judges a write names', () => {
    it('refuses a judge the contract does not name', () => {
      expect(
        wire.writeRequestSchema.safeParse({ handle: 0, batch: [], judge: 'workspace-sync' })
          .success,
      ).toBe(false)
    })
  })
}

export function describeSpliceWriter(makeEngine: () => CrdtEngine) {
  describe('a text splice a batch carries', () => {
    it('shares one commit with the writes beside it', async () => {
      const engine = makeEngine()
      const handle = openApart(engine, 'abcdef')
      const before = engine.export({ handle, mode: 'snapshot' }).bytes
      const result = applied(
        engine.write(
          wire.writeRequestSchema.parse({
            handle,
            batch: [
              {
                op: 'spliceText',
                args: { text: 'body', runs: [{ index: 0, remove: 2, insert: '😀' }] },
              },
              {
                op: 'spliceText',
                args: { text: 'body', runs: [{ index: 2, remove: 0, insert: '!' }] },
              },
            ],
          }),
        ),
      )
      expect(await bodyOf(engine, handle)).toBe('😀!cdef')
      // One commit: a peer holding the state before takes the whole batch from one update.
      const there = engine.open({ peer: '2', bytes: before })
      applied(engine.import({ handle: there.handle, bytes: result.localUpdate as string }))
      expect(await bodyOf(engine, there.handle)).toBe('😀!cdef')
      // And one undo step.
      engine.undo({ handle })
      expect(await bodyOf(engine, handle)).toBe('abcdef')
    })
  })
}

export function describeSpliceWriterHosted(makeEngine: () => CrdtEngine) {
  describe('a text splice a batch carries beside other writers and a host', () => {
    it('applies beside a writer of another kind, in the order the batch names', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'abc')
      applied(
        engine.write(
          wire.writeRequestSchema.parse({
            handle,
            batch: [
              { op: 'writeDocumentKind', args: { kind: 'markdown' } },
              {
                op: 'spliceText',
                args: { text: 'body', runs: [{ index: 3, remove: 0, insert: 'd' }] },
              },
            ],
          }),
        ),
      )
      expect(await bodyOf(engine, handle)).toBe('abcd')
      expect(await ask(engine, handle, 'documentKind')).toEqual({ ok: 'markdown' })
    })
  })
}

export function describeSpliceWriterHostedDocument(makeEngine: () => CrdtEngine) {
  describe('a text splice a batch carries into a hosted document', () => {
    it('splices the text of a hosted document, and leaves the document when a run is out of range', async () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      write(engine, handle, 'createWorkspaceDocumentAtPath', {
        path: 'note',
        documentId: FIRST,
        kind: 'markdown',
      })
      write(engine, handle, 'spliceText', {
        documentId: FIRST,
        text: 'body',
        runs: [{ index: 0, remove: 0, insert: 'inside' }],
      })
      expect(await bodyOf(engine, handle, FIRST)).toBe('inside')
      const batch = [
        {
          op: 'spliceText',
          args: { documentId: FIRST, text: 'body', runs: [{ index: 0, remove: 0, insert: 'X' }] },
        },
        {
          op: 'spliceText',
          args: { documentId: FIRST, text: 'body', runs: [{ index: 99, remove: 0, insert: 'Y' }] },
        },
      ]
      expect(() => engine.write(wire.writeRequestSchema.parse({ handle, batch }))).toThrow()
      expect(await bodyOf(engine, handle, FIRST)).toBe('inside')
    })
  })
}

const trashEntry = (documentId: string) => ({
  documentId,
  path: `gone/${documentId}`,
  deletedAt: 5000,
  blob: { algorithm: 'sha-256', digestHex: 'ab'.repeat(32) },
})

export function describeIndexWrites(makeEngine: () => CrdtEngine) {
  describe('the index writes of a workspace record', () => {
    it('forgets a trash entry and nothing else', async () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      write(engine, handle, 'recordTrashEntry', { entry: trashEntry(FIRST) })
      write(engine, handle, 'recordTrashEntry', { entry: trashEntry(SECOND) })
      const result = write(engine, handle, 'forgetTrashEntry', { documentId: FIRST })
      expect(result.localUpdate).toBeDefined()
      const left = (await ask(engine, handle, 'trash')) as { ok: Array<{ documentId: string }> }
      expect(left.ok.map((entry) => entry.documentId)).toEqual([SECOND])
      expect(result.changed).toEqual([])
    })

    it('names the folders that have no name and keeps the ones that have', async () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      write(engine, handle, 'createWorkspaceDocumentAtPath', {
        path: 'a/b/note',
        documentId: FIRST,
        kind: 'markdown',
      })
      write(engine, handle, 'setWorkspaceFolderName', { path: 'a', name: 'Kept' })
      write(engine, handle, 'reapplyFolderNames', {
        names: [
          { path: 'a', name: 'Replaced' },
          { path: 'a/b', name: 'Named' },
          { path: 'a/b', name: '' },
        ],
      })
      const names = (await ask(engine, handle, 'folderNames')) as {
        ok: Array<{ path: string; name: string }>
      }
      expect(Object.fromEntries(names.ok.map(({ path, name }) => [path, name]))).toEqual({
        a: 'Kept',
        'a/b': 'Named',
      })
    })
  })
}

function subtreeWorkspace(engine: CrdtEngine) {
  const { handle } = engine.open({ peer: '3' })
  write(engine, handle, 'createWorkspaceDocumentAtPath', {
    path: 'top',
    documentId: FIRST,
    kind: 'markdown',
  })
  write(engine, handle, 'createWorkspaceDocumentAtPath', {
    path: 'top/inner',
    documentId: SECOND,
    kind: 'markdown',
  })
  write(engine, handle, 'spliceText', {
    documentId: SECOND,
    text: 'body',
    runs: [{ index: 0, remove: 0, insert: 'inside' }],
  })
  return handle
}

export function describeSubtreeExport(makeEngine: () => CrdtEngine) {
  describe('an export of the subtree at a path', () => {
    it('exports the document with everything under it as a record that places back', async () => {
      const engine = makeEngine()
      const handle = subtreeWorkspace(engine)
      const { bytes } = wire.exportResponseSchema.parse(
        engine.export({ handle, mode: 'subtree', path: 'top' }),
      )
      expect(bytes).toBeDefined()
      const target = engine.open({ peer: '1' })
      const placed = applied(
        engine.importSubtree({
          handle: target.handle,
          bytes: bytes as string,
          parentPath: 'moved',
        }),
      )
      expect(placed.root).toEqual({ documentId: FIRST, path: 'moved/top' })
      expect(await bodyOf(engine, target.handle, SECOND)).toBe('inside')
      // The bytes are a record of their own, not the workspace they came from.
      const record = held(engine, handle, 'snapshot')
      expect(importWorkspaceSubtree(record, bytesOf(bytes as string), 'again')).not.toBeNull()
    })

    it('answers no bytes when no node is at the path', () => {
      const engine = makeEngine()
      const handle = subtreeWorkspace(engine)
      const answer = wire.exportResponseSchema.parse(
        engine.export({ handle, mode: 'subtree', path: 'nowhere' }),
      )
      expect(answer).toEqual({})
    })
  })
}
