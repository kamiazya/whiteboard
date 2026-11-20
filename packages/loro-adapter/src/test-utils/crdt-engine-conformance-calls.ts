/**
 * The conformance cases for the calls beyond the first engine surface: the
 * versions a document holds, a fork, what judges an import, the undo history,
 * a splice of several runs, the kind fallback of a content read, and a
 * subtree placed from exported bytes.
 */
import { MARKDOWN_MAX_CHARS, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { decodeFrontiers, LoroDoc, VersionVector } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { exportedBytes, frontierPairs, versionPairs } from '../engine/answers.js'
import type { CrdtEngine } from '../engine/types.js'
import { exportWorkspaceSubtree } from '../workspace-tree.js'
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
  splice,
  write,
} from './crdt-engine-conformance-kit.js'

const entriesOf = (pairs: Array<[string, number]>) =>
  pairs.map(([peer, counter]) => ({ peer, counter }))

export function describeVersion(makeEngine: () => CrdtEngine) {
  describe('what a document holds, as versions', () => {
    it('answers the version and frontiers of every operation held, and their encodings', () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'hello', '7')
      const answer = wire.versionResponseSchema.parse(engine.version({ handle }))
      const doc = held(engine, handle)
      expect(answer.version).toEqual(entriesOf(versionPairs(doc.oplogVersion())))
      expect(answer.frontiers).toEqual(entriesOf(frontierPairs(doc.oplogFrontiers())))
      expect(answer.version.length).toBeGreaterThan(0)
      expect(answer.frontiers.length).toBeGreaterThan(0)
      expect(VersionVector.decode(bytesOf(answer.encodedVersion)).compare(doc.oplogVersion())).toBe(
        0,
      )
      expect(decodeFrontiers(bytesOf(answer.encodedFrontiers))).toEqual(doc.oplogFrontiers())
    })
  })
}

export function describeVersionDecoding(makeEngine: () => CrdtEngine) {
  describe('decoding the versions an engine encoded', () => {
    it('decodes what it encoded, and nothing else', () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'hello', '7')
      const other = makeEngine()
      const there = other.open({
        peer: '5',
        bytes: engine.export({ handle, mode: 'snapshot' }).bytes,
      })
      const theirs = splice(other, there.handle, 5, 0, '!').localUpdate as string
      engine.import({ handle, bytes: theirs })
      const answer = engine.version({ handle })
      expect(
        engine.decode({ kind: 'version', bytes: answer.encodedVersion }).entries,
        'version',
      ).toEqual(answer.version)
      expect(
        engine.decode({ kind: 'frontiers', bytes: answer.encodedFrontiers }).entries,
        'frontiers',
      ).toEqual(answer.frontiers)
      expect(() => engine.decode({ kind: 'version', bytes: 'Zm9vYmFy' })).toThrow()
      expect(() => engine.decode({ kind: 'frontiers', bytes: 'Zm9vYmFy' })).toThrow()
    })

    it('moves its version forward with a write and not with a read', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'a')
      const first = engine.version({ handle })
      await bodyOf(engine, handle)
      expect(engine.version({ handle })).toEqual(first)
      splice(engine, handle, 1, 0, 'b')
      expect(engine.version({ handle })).not.toEqual(first)
    })
  })
}

export function describeFork(makeEngine: () => CrdtEngine) {
  describe('a fork', () => {
    it('copies the head under its own peer and then diverges from it', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'shared')
      const copy = engine.fork({ handle, peer: '2' })
      splice(engine, copy.handle, 6, 0, ' copy')
      splice(engine, handle, 0, 0, 'origin ')
      expect(await bodyOf(engine, copy.handle)).toBe('shared copy')
      expect(await bodyOf(engine, handle)).toBe('origin shared')
      splice(engine, copy.handle, 0, 0, '>')
      const theirs = exportedBytes(engine.export({ handle: copy.handle, mode: 'update' }))
      engine.import({ handle, bytes: theirs })
      expect(await bodyOf(engine, handle)).toBe('origin >shared copy')
      expect(
        engine
          .decode({
            kind: 'version',
            bytes: engine.version({ handle: copy.handle }).encodedVersion,
          })
          .entries.map(({ peer }) => peer),
      ).toContain('2')
    })

    it('views the document at a frontier, which can be read and not written', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'one')
      const at = engine.version({ handle }).frontiers
      splice(engine, handle, 3, 0, ' two')
      const view = engine.fork({ handle, peer: '2', at })
      expect(await bodyOf(engine, view.handle)).toBe('one')
      expect(await bodyOf(engine, handle)).toBe('one two')
      expect(() => splice(engine, view.handle, 0, 0, 'x')).toThrow()
      expect(() => engine.undo({ handle: view.handle })).toThrow()
      expect(await bodyOf(engine, view.handle)).toBe('one')
    })

    it('refuses a closed handle and a frontier the document never held', () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'x')
      expect(() => engine.fork({ handle, peer: '2', at: [{ peer: '99', counter: 5 }] })).toThrow()
      engine.close({ handle })
      expect(() => engine.fork({ handle, peer: '2' })).toThrow()
    })
  })
}

export function describeImportJudging(makeEngine: () => CrdtEngine) {
  describe('what judges an import', () => {
    const oversize = (engine: CrdtEngine, handle: number) => {
      const peer = held(engine, handle)
      const from = peer.oplogVersion()
      peer.setPeerId(9n)
      peer.getText('body').insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1))
      peer.commit()
      return Buffer.from(peer.export({ mode: 'update', from })).toString('base64')
    }

    it('judges by the text limits unless the host says it trusts the bytes', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'kept')
      const bytes = oversize(engine, handle)
      expect(mutation(engine.import({ handle, bytes }))).toMatchObject({ outcome: 'refused' })
      expect(mutation(engine.import({ handle, bytes, judge: 'text' }))).toMatchObject({
        outcome: 'refused',
      })
      expect(await bodyOf(engine, handle)).toBe('kept')
      expect(applied(engine.import({ handle, bytes, judge: 'none' })).pending).toBe(false)
      expect((await bodyOf(engine, handle)).length).toBe(MARKDOWN_MAX_CHARS + 1 + 4)
    }, 30_000)
  })
}

export function describeImportPending(makeEngine: () => CrdtEngine) {
  describe('whether an import is left pending', () => {
    it('says whether an import builds on operations the document lacks', async () => {
      const a = makeEngine()
      const handle = openWith(a, 'base')
      const peer = held(a, handle)
      peer.setPeerId(5n)
      const from = peer.oplogVersion()
      peer.getText('body').insert(0, 'one ')
      peer.commit()
      const middle = peer.oplogVersion()
      peer.getText('body').insert(0, 'two ')
      peer.commit()
      const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
      const second = b64(peer.export({ mode: 'update', from: middle }))
      const first = b64(peer.export({ mode: 'update', from }))
      for (const judge of ['text', 'none'] as const) {
        const engine = makeEngine()
        const there = engine.open({
          peer: '1',
          bytes: a.export({ handle, mode: 'snapshot' }).bytes,
        })
        expect(
          applied(engine.import({ handle: there.handle, bytes: second, judge })).pending,
          judge,
        ).toBe(true)
        expect(
          applied(engine.import({ handle: there.handle, bytes: first, judge })).pending,
          judge,
        ).toBe(false)
        expect(await bodyOf(engine, there.handle), judge).toBe('two one base')
      }
    })
  })
}

export function describeUndoHistory(makeEngine: () => CrdtEngine) {
  describe('the undo history', () => {
    it('says what an undo and a redo could do, and forgets both on a clear', () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      expect(engine.undoState({ handle })).toEqual({ canUndo: false, canRedo: false })
      write(engine, handle, 'writeMarkdownBody', { body: 'a' })
      expect(engine.undoState({ handle })).toEqual({ canUndo: true, canRedo: false })
      engine.undo({ handle })
      expect(engine.undoState({ handle })).toEqual({ canUndo: false, canRedo: true })
      engine.undoClear({ handle })
      expect(engine.undoState({ handle })).toEqual({ canUndo: false, canRedo: false })
      expect(mutation(engine.redo({ handle }))).toEqual({ outcome: 'applied', changed: [] })
    })

    it('merges edits inside the merge interval into one step, and keeps each apart at zero', async () => {
      const merged = makeEngine()
      const together = merged.open({ peer: '1', undoMergeIntervalMs: 60_000 })
      splice(merged, together.handle, 0, 0, 'a')
      splice(merged, together.handle, 1, 0, 'b')
      merged.undo({ handle: together.handle })
      expect(await bodyOf(merged, together.handle)).toBe('')

      const apart = merged.open({ peer: '2', undoMergeIntervalMs: 0 })
      splice(merged, apart.handle, 0, 0, 'a')
      splice(merged, apart.handle, 1, 0, 'b')
      merged.undo({ handle: apart.handle })
      expect(await bodyOf(merged, apart.handle)).toBe('a')
    })

    it('refuses a negative merge interval', () => {
      expect(() => makeEngine().open({ peer: '1', undoMergeIntervalMs: -1 })).toThrow()
    })
  })
}

export function describeSpliceRuns(makeEngine: () => CrdtEngine) {
  describe('a splice of several runs', () => {
    it('applies the runs in order, each against what the runs before it left, as one update', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'abcdef')
      const result = applied(
        engine.textSplice(
          wire.textSpliceRequestSchema.parse({
            handle,
            text: 'body',
            runs: [
              { index: 0, remove: 2, insert: 'X' },
              { index: 1, remove: 0, insert: '😀' },
              { index: 4, remove: 1, insert: 'YZ' },
            ],
          }),
        ),
      )
      expect(await bodyOf(engine, handle)).toBe('X😀cYZef')
      expect(result.localUpdate).toBeDefined()
      const peer = engine.open({
        peer: '2',
        bytes: engine.export({ handle, mode: 'snapshot' }).bytes,
      })
      expect(await bodyOf(engine, peer.handle)).toBe(await bodyOf(engine, handle))
    })
  })
}

export function describeSpliceRunsRefused(makeEngine: () => CrdtEngine) {
  describe('a splice with a run that cannot apply', () => {
    it('leaves the document as it was when one run is out of range', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'abc')
      const request = wire.textSpliceRequestSchema.parse({
        handle,
        text: 'body',
        runs: [
          { index: 0, remove: 0, insert: 'X' },
          { index: 99, remove: 0, insert: 'Y' },
        ],
      })
      expect(() => engine.textSplice(request)).toThrow()
      expect(await bodyOf(engine, handle)).toBe('abc')
    })

    it('answers nothing changed for a splice with no run', () => {
      const request = { handle: 0, text: 'body', runs: [] }
      expect(wire.textSpliceRequestSchema.safeParse(request).success).toBe(true)
      const engine = makeEngine()
      const handle = openWith(engine, 'abc')
      expect(mutation(engine.textSplice({ ...request, handle }))).toEqual({
        outcome: 'applied',
        changed: [],
      })
    })
  })
}

export function describeDocumentKindFallback(makeEngine: () => CrdtEngine) {
  describe('a document content read with the kind its index row records', () => {
    it('reads a document that records no kind as the kind the row names, and as a canvas otherwise', async () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      const bare = (await ask(engine, handle, 'documentContent')) as { ok: { kind: string } }
      expect(bare.ok.kind).toBe('spatial')
      const named = (await ask(engine, handle, 'documentContent', { kind: 'markdown' })) as {
        ok: { kind: string }
      }
      expect(named.ok.kind).toBe('markdown')
    })

    it('lets the kind the document records win over the row', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'text')
      write(engine, handle, 'writeDocumentKind', { kind: 'spatial' })
      const answer = (await ask(engine, handle, 'documentContent', { kind: 'markdown' })) as {
        ok: { kind: string }
      }
      expect(answer.ok.kind).toBe('spatial')
    })
  })
}

type Okay = { ok: Record<string, unknown> | undefined }

/** What the two separate reads answer, in the shape the combined read owes. */
async function separateReads(
  engine: CrdtEngine,
  handle: number,
  args: Record<string, unknown> | undefined,
) {
  const content = ((await ask(engine, handle, 'documentContent', args)) as Okay).ok as {
    kind: string
  }
  const core = ((await ask(engine, handle, 'coreFacets', args)) as Okay).ok as
    | { tags?: string[] }
    | undefined
  const tags = content.kind === 'markdown' ? core?.tags : undefined
  return { ok: tags === undefined ? { content } : { content, tags } }
}

const TAGGED_READ_CASES: Array<[string, (engine: CrdtEngine, handle: number) => void]> = [
  [
    'a markdown document with tags',
    (engine, handle) => {
      write(engine, handle, 'writeDocumentKind', { kind: 'markdown' })
      write(engine, handle, 'writeMarkdownBody', { body: 'tagged' })
      write(engine, handle, 'writeCoreFacets', {
        core: { type: 'note', description: 'about', tags: ['a', 'team:b'] },
      })
    },
  ],
  [
    'a markdown document without tags',
    (engine, handle) => {
      write(engine, handle, 'writeDocumentKind', { kind: 'markdown' })
      write(engine, handle, 'writeMarkdownBody', { body: 'plain' })
      write(engine, handle, 'writeCoreFacets', { core: { type: 'note' } })
    },
  ],
  [
    'a markdown document that records no core facets',
    (engine, handle) => {
      write(engine, handle, 'writeDocumentKind', { kind: 'markdown' })
      write(engine, handle, 'writeMarkdownBody', { body: 'bare' })
    },
  ],
  [
    'a spatial document with tags on its canvas',
    (engine, handle) => {
      write(engine, handle, 'writeDocumentKind', { kind: 'spatial' })
      write(engine, handle, 'writeSpatialCanvas', {
        canvas: { nodes: [], edges: [], tags: ['board'] },
      })
    },
  ],
  ['a spatial document without tags', () => {}],
]

export function describeDocumentContentWithTags(makeEngine: () => CrdtEngine) {
  describe('a document content read that carries the tags', () => {
    it.each(TAGGED_READ_CASES)('answers what the two reads answer for %s', async (_name, seed) => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      seed(engine, handle)
      expect(await ask(engine, handle, 'documentContentWithTags')).toEqual(
        await separateReads(engine, handle, undefined),
      )
    })

    it('answers the same for a document a workspace record hosts, and with the row kind', async () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      write(engine, handle, 'createWorkspaceDocumentAtPath', {
        path: 'note',
        documentId: FIRST,
        kind: 'markdown',
      })
      write(engine, handle, 'writeCoreFacets', {
        documentId: FIRST,
        core: { type: 'note', tags: ['hosted'] },
      })
      for (const args of [{ documentId: FIRST }, { documentId: FIRST, kind: 'markdown' }]) {
        const combined = (await ask(engine, handle, 'documentContentWithTags', args)) as Okay
        expect(combined).toEqual(await separateReads(engine, handle, args))
        // The node's own kind is not consulted: only the row's, when asked with it.
        if ('kind' in args) expect(combined.ok).toMatchObject({ tags: ['hosted'] })
      }
    })

    it('refuses what the content read refuses', async () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      const combined = await ask(engine, handle, 'documentContentWithTags', {
        documentId: FIRST,
      })
      expect(combined).toEqual(await ask(engine, handle, 'documentContent', { documentId: FIRST }))
      expect(combined).toHaveProperty('err')
    })
  })
}

/** Exported subtree bytes of a markdown document with a body, as base64. */
function subtreeSource(engine: CrdtEngine): string {
  const { handle } = engine.open({ peer: '3' })
  write(engine, handle, 'createWorkspaceDocumentAtPath', {
    path: 'notes/kept',
    documentId: FIRST,
    kind: 'markdown',
  })
  splice(engine, handle, 0, 0, 'inside', FIRST)
  const bytes = exportWorkspaceSubtree(held(engine, handle, 'snapshot'), 'notes/kept')
  if (bytes === null) throw new Error('the fixture holds no such document')
  return Buffer.from(bytes).toString('base64')
}

export function describeSubtreeImport(makeEngine: () => CrdtEngine) {
  describe('a document placed from exported subtree bytes', () => {
    it('places the document under the folder it is given, and names it as changed', async () => {
      const engine = makeEngine()
      const bytes = subtreeSource(engine)
      const { handle } = engine.open({ peer: '1' })
      const result = applied(engine.importSubtree({ handle, bytes, parentPath: 'restored' }))
      expect(result.changed).toContain(FIRST)
      expect(result.root).toEqual({ documentId: FIRST, path: 'restored/kept' })
      const entry = (await ask(engine, handle, 'workspaceDocumentEntry', {
        documentId: FIRST,
      })) as {
        ok: { path: string } | null
      }
      expect(entry.ok?.path).toBe('restored/kept')
      expect(await bodyOf(engine, handle, FIRST)).toBe('inside')
    })

    it('answers nothing changed for bytes that hold no document', () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      const empty = Buffer.from(new LoroDoc().export({ mode: 'snapshot' })).toString('base64')
      expect(mutation(engine.importSubtree({ handle, bytes: empty }))).toEqual({
        outcome: 'applied',
        changed: [],
      })
    })
  })
}

export function describeSubtreeRoot(makeEngine: () => CrdtEngine) {
  describe('the root a subtree import names', () => {
    it('names the top of the bytes as the root, not a document beneath it', () => {
      const engine = makeEngine()
      const { handle: from } = engine.open({ peer: '3' })
      write(engine, from, 'createWorkspaceDocumentAtPath', {
        path: 'top',
        documentId: FIRST,
        kind: 'markdown',
      })
      write(engine, from, 'createWorkspaceDocumentAtPath', {
        path: 'top/inner',
        documentId: SECOND,
        kind: 'markdown',
      })
      const exported = exportWorkspaceSubtree(held(engine, from, 'snapshot'), 'top')
      if (exported === null) throw new Error('the fixture holds no such document')
      const { handle } = engine.open({ peer: '1' })
      const result = applied(
        engine.importSubtree({ handle, bytes: Buffer.from(exported).toString('base64') }),
      )
      expect(result.root).toEqual({ documentId: FIRST, path: 'top' })
    })
  })
}
