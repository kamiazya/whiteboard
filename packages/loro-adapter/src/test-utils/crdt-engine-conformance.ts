/**
 * What a CRDT document engine promises beyond its signature, for every engine
 * that implements `contracts/crdt/document-engine.schema.json`: the TypeScript
 * one over npm loro-crdt today, the Rust one over the Loro crate later.
 *
 * It replays the two committed recordings through the engine's own calls — the
 * read oracle through `open` and `read`, the write oracle through `open`,
 * `write` and `export` — and then holds the contract-level properties no row
 * states: an export opens as the same document, undo and redo restore, a text
 * splice counts UTF-16 units, a journal rebuilds a lost handle, and two engines
 * that trade their local updates converge.
 *
 * The comparison is made on bytes the engine EXPORTED, decoded by npm loro-crdt
 * here, so an engine is judged by the document it leaves behind and not by what
 * it says about it.
 */
import { readFileSync } from 'node:fs'
import { MARKDOWN_MAX_CHARS, documentEngine as wire } from '@kamiazya/whiteboard-model'
import { decodeImportBlobMeta, type LoroDoc } from 'loro-crdt'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { exportedBytes, frontierPairs, type VersionPairs, versionPairs } from '../engine/answers.js'
import { journaledEngine } from '../engine/journal.js'
import type { CrdtEngine } from '../engine/types.js'
import {
  describeDocumentContentWithTags,
  describeDocumentKindFallback,
  describeFork,
  describeImportJudging,
  describeImportPending,
  describeRetiredCommentPlane,
  describeSpliceRuns,
  describeSpliceRunsRefused,
  describeSubtreeImport,
  describeSubtreeRoot,
  describeUndoHistory,
  describeVersion,
  describeVersionDecoding,
  describeViewMove,
} from './crdt-engine-conformance-calls.js'
import {
  applied,
  ask,
  bodyOf,
  bytesOf,
  FIRST,
  held,
  jsonOf,
  mutation,
  openWith,
  SECOND,
  splice,
  WORKSPACE_DOCUMENT,
  write,
} from './crdt-engine-conformance-kit.js'
import {
  describeOpenWithUpdates,
  describeReadNow,
  describeTrim,
} from './crdt-engine-conformance-lifecycle.js'
import { describeProjectionExport } from './crdt-engine-conformance-projection.js'
import { describeWorkspaceSyncJudging } from './crdt-engine-conformance-workspace-sync.js'
import {
  describeIndexWrites,
  describeJudgeVocabulary,
  describeSpliceJudging,
  describeSpliceWriter,
  describeSpliceWriterHosted,
  describeSpliceWriterHostedDocument,
  describeSubtreeExport,
  describeUndoJudging,
  describeWriteJudging,
  describeWriteJudgingThrow,
} from './crdt-engine-conformance-writes.js'
import { fc, withDefaults } from './fast-check.js'

const recorded = (name: string) =>
  readFileSync(new URL(`../oracle/${name}`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as unknown)

/** The clock every recorded write ran under. */
const RECORDED_NOW = 1_700_000_000_000

interface ReadRow {
  id: string
  host: 'workspace' | 'document'
  since: VersionPairs
  snapshot: string
  updates: string
  shallow: string
  deep: { updates: unknown } & Record<'snapshot' | 'shallow', unknown>
  ids: unknown
  vv: VersionPairs
  frontiers: Array<[string, number]>
  readers: Record<string, unknown>
}

interface WriteRow {
  id: string
  op: string
  host: 'workspace' | 'document'
  peer: number
  before: string
  args: unknown
  result: { ok: unknown } | { err: string }
  deep: unknown
  ids: unknown
  vv: VersionPairs
  frontiers: Array<[string, number]>
  update: string
}

const versionEntries = (doc: LoroDoc) =>
  versionPairs(doc.oplogVersion()).map(([peer, counter]) => ({ peer, counter }))

/** The readers that answer from a version, which a recorded row names in `since`. */
const SINCE_READERS = new Set(['removedSince', 'touchedSince', 'organisationChangedSince'])
const ROOT_ONLY_READERS = new Set(['stateSize', 'contentDigest', 'textLimitBreach'])

async function expectPerDocument(
  engine: CrdtEngine,
  handle: number,
  key: string,
  expected: { ok?: unknown },
  label: string,
  contentNames: readonly string[],
) {
  const hashed = /^(.*)#(entry|projection)$/.exec(key)
  if (hashed !== null) {
    const query = hashed[2] === 'entry' ? 'workspaceDocumentEntry' : 'workspaceDocumentProjection'
    expect(await ask(engine, handle, query, { documentId: hashed[1] as string }), label).toEqual(
      expected,
    )
    return
  }
  const record = 'ok' in expected ? (expected.ok as Record<string, unknown>) : null
  for (const name of record === null ? contentNames : Object.keys(record)) {
    const answer = await ask(engine, handle, name, { documentId: key })
    expect(answer, `${label} ${name}`).toEqual(record === null ? expected : record[name])
  }
}

function describeReadReplay(makeEngine: () => CrdtEngine) {
  const rows = recorded('crdt-read.jsonl') as ReadRow[]
  const contentNames = Object.keys(
    (rows.find((row) => row.host === 'document') as ReadRow).readers,
  ).filter((name) => !ROOT_ONLY_READERS.has(name))

  async function expectReaders(engine: CrdtEngine, handle: number, row: ReadRow, label: string) {
    for (const [name, expected] of Object.entries(row.readers)) {
      if (name === 'perDocument') continue
      const args = SINCE_READERS.has(name) ? { since: row.since } : undefined
      expect(await ask(engine, handle, name, args), `${label} ${name}`).toEqual(expected)
    }
    const perDocument = (row.readers.perDocument ?? {}) as Record<string, { ok?: unknown }>
    for (const [key, expected] of Object.entries(perDocument)) {
      await expectPerDocument(engine, handle, key, expected, `${label} ${key}`, contentNames)
    }
  }

  describe('replays the recorded read oracle through open and read', () => {
    it.each(rows.map((row) => [row.id, row] as const))('%s', async (_id, row) => {
      for (const file of ['snapshot', 'updates'] as const) {
        const engine = makeEngine()
        const { handle } = engine.open({ peer: '1', bytes: row[file] })
        const doc = held(engine, handle, file === 'updates' ? 'update' : 'snapshot')
        expect(doc.toJSON(), `${file} deep value`).toEqual(row.deep[file] ?? row.deep.updates)
        if (file === 'updates') {
          expect(doc.getDeepValueWithID(), 'container ids').toEqual(row.ids)
        }
        expect(versionPairs(doc.oplogVersion()), `${file} version vector`).toEqual(row.vv)
        expect(frontierPairs(doc.frontiers()), `${file} frontiers`).toEqual(row.frontiers)
        await expectReaders(engine, handle, row, file)
      }
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1', bytes: row.shallow })
      const shallow = held(engine, handle, 'snapshot')
      expect(shallow.toJSON(), 'shallow deep value').toEqual(row.deep.shallow ?? row.deep.updates)
      expect(frontierPairs(shallow.frontiers()), 'shallow frontiers').toEqual(row.frontiers)
    })
  })
}

/** `minimalChange` is recorded for the helper's own parity and is no document write. */
function replayedWriteRows(): WriteRow[] {
  const rows = (recorded('crdt-write.jsonl') as WriteRow[]).filter(
    (row) => row.op !== 'minimalChange',
  )
  expect(rows.length, 'replayed write rows').toBeGreaterThan(400)
  return rows
}

function describeWriteReplay(makeEngine: () => CrdtEngine) {
  const rows = replayedWriteRows()
  /** Whether the write left an operation for a peer to import. */
  const changed = (row: WriteRow) => decodeImportBlobMeta(bytesOf(row.update), false).changeNum > 0

  describe('replays the recorded write oracle through open, write and export', () => {
    beforeAll(() => {
      vi.spyOn(Date, 'now').mockReturnValue(RECORDED_NOW)
    })
    afterAll(() => {
      vi.restoreAllMocks()
    })

    it.each(rows.map((row) => [row.id, row] as const))('%s', (_id, row) => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: String(row.peer), bytes: row.before })
      const request = wire.writeRequestSchema.parse({
        handle,
        batch: [{ op: row.op, args: jsonOf(row.args) }],
      })
      if ('err' in row.result) {
        let thrown: unknown
        try {
          engine.write(request)
        } catch (error) {
          thrown = error
        }
        expect(thrown instanceof Error ? thrown.constructor.name : typeof thrown, 'refusal').toBe(
          row.result.err,
        )
        // The recording keeps what a writer wrote before it refused; the
        // contract says a refused call changed nothing.
        const untouched = makeEngine()
        const reference = untouched.open({ peer: String(row.peer), bytes: row.before }).handle
        expect(held(engine, handle).toJSON(), 'a refused write leaves the document').toEqual(
          held(untouched, reference).toJSON(),
        )
        return
      }
      const result = applied(engine.write(request))
      const after = held(engine, handle)
      expect(after.toJSON(), 'deep value').toEqual(row.deep)
      expect(after.getDeepValueWithID(), 'container ids').toEqual(row.ids)
      expect(versionPairs(after.oplogVersion()), 'version vector').toEqual(row.vv)
      expect(frontierPairs(after.frontiers()), 'frontiers').toEqual(row.frontiers)
      expect(result.localUpdate, 'update bytes').toEqual(changed(row) ? row.update : undefined)
      expect(result.changed.length > 0 && result.localUpdate === undefined, 'changed').toBe(false)
    })
  })
}

function describeExportAndImport(makeEngine: () => CrdtEngine) {
  describe('export and import', () => {
    it('opens a snapshot as the document it was exported from', async () => {
      const a = makeEngine()
      const handle = openWith(a, 'hello 😀')
      const { bytes } = a.export({ handle, mode: 'snapshot' })
      const b = makeEngine()
      const opened = b.open({ peer: '2', bytes })
      expect(await bodyOf(b, opened.handle)).toBe('hello 😀')
      expect(held(b, opened.handle).toJSON()).toEqual(held(a, handle).toJSON())
    })

    it('merges an update into a document that holds the version it builds on', async () => {
      const a = makeEngine()
      const handle = openWith(a, 'one')
      const b = makeEngine()
      const opened = b.open({ peer: '2', bytes: a.export({ handle, mode: 'snapshot' }).bytes })
      const from = versionEntries(held(a, handle))
      write(a, handle, 'writeMarkdownBody', { body: 'one two' })
      const bytes = exportedBytes(a.export({ handle, mode: 'update', from }))
      expect(mutation(b.import({ handle: opened.handle, bytes })).outcome).toBe('applied')
      expect(await bodyOf(b, opened.handle)).toBe('one two')
    })

    it('exports a shallow snapshot that opens at the same state without the history before it', async () => {
      const a = makeEngine()
      const handle = openWith(a, 'kept')
      const frontiers = frontierPairs(held(a, handle).frontiers()).map(([peer, counter]) => ({
        peer,
        counter,
      }))
      write(a, handle, 'writeMarkdownBody', { body: 'kept and more' })
      const { bytes } = a.export({ handle, mode: 'shallow-snapshot', frontiers })
      const b = makeEngine()
      const opened = b.open({ peer: '2', bytes })
      expect(await bodyOf(b, opened.handle)).toBe('kept and more')
    })

    it('answers an update with nothing to say as no update', () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      const result = write(engine, handle, 'writeMarkdownBody', { body: '' })
      expect(result).toEqual({ outcome: 'applied', changed: [] })
    })
  })
}

function describeClose(makeEngine: () => CrdtEngine) {
  describe('close', () => {
    it('refuses every call on a closed handle and leaves the others open', async () => {
      const engine = makeEngine()
      const closed = openWith(engine, 'gone')
      const open = openWith(engine, 'kept')
      engine.close(wire.closeRequestSchema.parse({ handle: closed }))
      expect(() => engine.export({ handle: closed, mode: 'snapshot' })).toThrow(/closed/)
      expect(() => engine.undo({ handle: closed })).toThrow(/closed/)
      expect(() => splice(engine, closed, 0, 0, 'x')).toThrow(/closed/)
      await expect(bodyOf(engine, closed)).rejects.toThrow(/closed/)
      expect(() => engine.close({ handle: closed })).toThrow(/closed/)
      expect(await bodyOf(engine, open)).toBe('kept')
    })

    it('never gives a closed handle number to a later document', () => {
      const engine = makeEngine()
      const closed = engine.open({ peer: '1' }).handle
      engine.close({ handle: closed })
      expect(engine.open({ peer: '1' }).handle).not.toBe(closed)
    })

    it('drops the journal of a closed handle', () => {
      const journaled = journaledEngine(makeEngine())
      const { handle } = journaled.open({ peer: '1' })
      journaled.close({ handle })
      expect(() => journaled.journal(handle)).toThrow()
    })
  })
}

function describeUndoAndRedo(makeEngine: () => CrdtEngine) {
  describe('undo and redo', () => {
    it('undoes a write and redoes it, each as a local update a peer can take', async () => {
      const a = makeEngine()
      const peer = makeEngine()
      const handle = openWith(a, 'typed')
      const first = a.export({ handle, mode: 'snapshot' }).bytes
      const there = peer.open({ peer: '2', bytes: first })

      const undone = applied(a.undo({ handle }))
      expect(await bodyOf(a, handle)).toBe('')
      expect(undone.localUpdate, 'undo is a local change').toBeDefined()
      peer.import({ handle: there.handle, bytes: undone.localUpdate as string })
      expect(await bodyOf(peer, there.handle)).toBe('')

      const redone = applied(a.redo({ handle }))
      expect(await bodyOf(a, handle)).toBe('typed')
      expect(redone.localUpdate, 'redo is a local change').toBeDefined()
      peer.import({ handle: there.handle, bytes: redone.localUpdate as string })
      expect(await bodyOf(peer, there.handle)).toBe('typed')
    })

    it('answers nothing changed when there is nothing to undo or redo', () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      expect(mutation(engine.undo({ handle }))).toEqual({ outcome: 'applied', changed: [] })
      expect(mutation(engine.redo({ handle }))).toEqual({ outcome: 'applied', changed: [] })
    })

    it('does not undo what a peer wrote', async () => {
      const a = makeEngine()
      const b = makeEngine()
      const handle = openWith(a, 'mine')
      const there = b.open({ peer: '2', bytes: a.export({ handle, mode: 'snapshot' }).bytes })
      const theirs = splice(b, there.handle, 4, 0, ' and theirs')
      a.import({ handle, bytes: theirs.localUpdate as string })
      expect(applied(a.undo({ handle })).localUpdate).toBeDefined()
      expect(await bodyOf(a, handle)).toBe(' and theirs')
      expect(mutation(a.undo({ handle }))).toEqual({ outcome: 'applied', changed: [] })
    })
  })
}

function describeTextSpliceUtf16(makeEngine: () => CrdtEngine) {
  describe('a text splice counts UTF-16 code units', () => {
    it('places an edit after an astral character by its two units', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'a😀b')
      splice(engine, handle, 3, 1, 'X')
      expect(await bodyOf(engine, handle)).toBe('a😀X')
    })

    it('removes an astral character as two units and inserts one whole', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'a😀b')
      splice(engine, handle, 1, 2, '𝒳')
      expect(await bodyOf(engine, handle)).toBe('a𝒳b')
      splice(engine, handle, 1, 0, '🎉')
      expect(await bodyOf(engine, handle)).toBe('a🎉𝒳b')
    })

    it('splices a document hosted on a workspace node and names it as changed', async () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      write(engine, handle, 'createWorkspaceDocument', WORKSPACE_DOCUMENT)
      const first = splice(engine, handle, 0, 0, '😀 hi', FIRST)
      expect(first.changed).toEqual([FIRST])
      const second = splice(engine, handle, 2, 3, 'yo', FIRST)
      expect(second.changed).toEqual([FIRST])
      expect(await bodyOf(engine, handle, FIRST)).toBe('😀yo')
    })
  })
}

function describeChanged(makeEngine: () => CrdtEngine) {
  describe('what a mutation reports as changed', () => {
    it('names the documents an edit reached and no other', () => {
      const engine = makeEngine()
      const { handle } = engine.open({ peer: '1' })
      const created = write(engine, handle, 'createWorkspaceDocument', WORKSPACE_DOCUMENT)
      expect(created.changed).toEqual([FIRST])
      write(engine, handle, 'createWorkspaceDocument', {
        ...WORKSPACE_DOCUMENT,
        documentId: SECOND,
        segment: 'other',
      })
      const edited = splice(engine, handle, 0, 0, 'x', SECOND)
      expect(edited.changed).toEqual([SECOND])
      const renamed = write(engine, handle, 'setWorkspaceDocumentName', {
        documentId: FIRST,
        name: 'Renamed',
      })
      expect(renamed.changed).toEqual([FIRST])
    })

    it('names what an import reached', () => {
      const a = makeEngine()
      const b = makeEngine()
      const { handle } = a.open({ peer: '1' })
      write(a, handle, 'createWorkspaceDocument', WORKSPACE_DOCUMENT)
      const there = b.open({ peer: '2', bytes: a.export({ handle, mode: 'snapshot' }).bytes })
      const edit = splice(a, handle, 0, 0, 'x', FIRST)
      expect(
        mutation(b.import({ handle: there.handle, bytes: edit.localUpdate as string })),
      ).toEqual({ outcome: 'applied', changed: [FIRST], pending: false })
    })
  })
}

function describeRefusal(makeEngine: () => CrdtEngine) {
  describe('a refusal changes nothing', () => {
    it('leaves the document as it was when a writer of the batch throws', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'kept')
      const before = held(engine, handle).toJSON()
      const batch = [
        { op: 'writeMarkdownBody', args: { body: 'lost' } },
        { op: 'createWorkspaceDocument', args: { segment: 'no id' } },
      ]
      expect(() => engine.write(wire.writeRequestSchema.parse({ handle, batch }))).toThrow()
      expect(held(engine, handle).toJSON()).toEqual(before)
      expect(await bodyOf(engine, handle)).toBe('kept')
    })

    it('refuses a pure helper as a write and a negative splice, changing nothing', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'kept')
      const helper = { handle, batch: [{ op: 'minimalChange', args: { current: 'a', next: 'b' } }] }
      expect(() => engine.write(helper as never)).toThrow()
      expect(() => splice(engine, handle, -1, 0, 'x')).toThrow()
      expect(() => splice(engine, handle, 0, -1, 'x')).toThrow()
      expect(await bodyOf(engine, handle)).toBe('kept')
    })

    it('refuses a local update past a sync limit, naming the container', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'kept')
      const refused = mutation(
        engine.write(
          wire.writeRequestSchema.parse({
            handle,
            batch: [
              { op: 'writeMarkdownBody', args: { body: 'x'.repeat(MARKDOWN_MAX_CHARS + 1) } },
            ],
          }),
        ),
      )
      expect(refused).toMatchObject({ outcome: 'refused', breach: { shape: 'run' } })
      expect(JSON.stringify(refused)).toMatch(/cid:/)
      expect(refused).not.toHaveProperty('localUpdate')
      expect(refused).not.toHaveProperty('changed')
      expect(await bodyOf(engine, handle)).toBe('kept')
      write(engine, handle, 'writeMarkdownBody', { body: 'still works' })
      expect(await bodyOf(engine, handle)).toBe('still works')
    })

    it('refuses an incoming update past a sync limit and keeps the document', async () => {
      const engine = makeEngine()
      const handle = openWith(engine, 'kept')
      const from = held(engine, handle).oplogVersion()
      const peer = held(engine, handle)
      peer.setPeerId(9n)
      peer.getText('body').insert(0, 'x'.repeat(MARKDOWN_MAX_CHARS + 1))
      peer.commit()
      const bytes = Buffer.from(peer.export({ mode: 'update', from })).toString('base64')
      const refused = mutation(engine.import({ handle, bytes }))
      expect(refused).toMatchObject({ outcome: 'refused', breach: { shape: 'run' } })
      expect(await bodyOf(engine, handle)).toBe('kept')
    })
  })
}

function describeJournal(makeEngine: () => CrdtEngine) {
  describe('a journal rebuilds a lost handle', () => {
    it('rebuilds a document from its base and the updates since', () => {
      const journaled = journaledEngine(makeEngine())
      const { handle } = journaled.open({ peer: '1' })
      write(journaled, handle, 'writeMarkdownBody', { body: 'first' })
      splice(journaled, handle, 5, 0, ' 😀 second')
      const journal = journaled.journal(handle)
      expect(journal.pending.length, 'updates held since the base').toBe(2)

      const afresh = journaledEngine(makeEngine())
      const again = afresh.rehydrate(journal)
      expect(held(afresh, again.handle).toJSON()).toEqual(held(journaled, handle).toJSON())
      expect(versionPairs(held(afresh, again.handle).oplogVersion())).toEqual(
        versionPairs(held(journaled, handle).oplogVersion()),
      )
    })

    it('keeps what the keeper has not acknowledged and folds the rest into the base', async () => {
      const journaled = journaledEngine(makeEngine())
      const { handle } = journaled.open({ peer: '1' })
      const first = journaled.write(
        wire.writeRequestSchema.parse({
          handle,
          batch: [{ op: 'writeMarkdownBody', args: { body: 'first' } }],
        }),
      )
      const second = journaled.textSplice(
        wire.textSpliceRequestSchema.parse({
          handle,
          text: 'body',
          runs: [{ index: 5, remove: 0, insert: ' second' }],
        }),
      )
      expect(first.seq).toBe(1)
      expect(second.seq).toBe(2)
      journaled.acknowledge(handle, 1)
      const journal = journaled.journal(handle)
      expect(journal.pending.map(({ seq }) => seq)).toEqual([2])

      const afresh = journaledEngine(makeEngine())
      const again = afresh.rehydrate(journal)
      expect(await bodyOf(afresh, again.handle)).toBe('first second')
    })

    it('carries what a peer sent, and the next local update continues the peer', async () => {
      const journaled = journaledEngine(makeEngine())
      const peerEngine = makeEngine()
      const { handle } = journaled.open({ peer: '1' })
      write(journaled, handle, 'writeMarkdownBody', { body: 'base' })
      const there = peerEngine.open({
        peer: '2',
        bytes: journaled.export({ handle, mode: 'snapshot' }).bytes,
      })
      const theirs = splice(peerEngine, there.handle, 4, 0, ' theirs')
      journaled.import({ handle, bytes: theirs.localUpdate as string })

      const afresh = journaledEngine(makeEngine())
      const again = afresh.rehydrate(journaled.journal(handle))
      expect(await bodyOf(afresh, again.handle)).toBe('base theirs')
      const mine = splice(afresh, again.handle, 0, 0, '>')
      peerEngine.import({ handle: there.handle, bytes: mine.localUpdate as string })
      expect(await bodyOf(peerEngine, there.handle)).toBe('>base theirs')
    })
  })
}

/** The body a fresh engine holds once it has rebuilt a document from its journal. */
async function rebuiltBody(
  makeEngine: () => CrdtEngine,
  journal: Parameters<ReturnType<typeof journaledEngine>['rehydrate']>[0],
): Promise<string> {
  const afresh = journaledEngine(makeEngine())
  return bodyOf(afresh, afresh.rehydrate(journal).handle)
}

function describeJournalOfParkedUpdates(makeEngine: () => CrdtEngine) {
  describe('a journal keeps an update opened before the one it builds on', () => {
    // B is authored on top of A; a keeper's log can hand B over first.
    const authored = () => {
      const author = makeEngine()
      const { handle } = author.open({ peer: '7' })
      const a = write(author, handle, 'writeMarkdownBody', { body: 'a' }).localUpdate as string
      const b = splice(author, handle, 1, 0, 'b').localUpdate as string
      return { a, b }
    }

    it('rebuilds the body once the missing update arrives', async () => {
      const { a, b } = authored()
      const journaled = journaledEngine(makeEngine())
      const { handle } = journaled.open({ peer: '1', updates: [b] })
      journaled.import({ handle, bytes: a })
      expect(await bodyOf(journaled, handle)).toBe('ab')
      expect(await rebuiltBody(makeEngine, journaled.journal(handle))).toBe('ab')
    })

    it('does not fold a still-parked update away when the keeper acknowledges', async () => {
      const { a, b } = authored()
      const journaled = journaledEngine(makeEngine())
      const { handle } = journaled.open({ peer: '1', updates: [b] })
      const mine = write(journaled, handle, 'writeMarkdownBody', { body: 'mine' })
      journaled.acknowledge(handle, (mine as { seq?: number }).seq ?? 1)
      journaled.import({ handle, bytes: a })
      const live = await bodyOf(journaled, handle)

      const afresh = journaledEngine(makeEngine())
      const again = afresh.rehydrate(journaled.journal(handle))
      expect(await bodyOf(afresh, again.handle)).toBe(live)
      expect(afresh.journal(again.handle).pending.length).toBeGreaterThan(0)
    })

    it('rebuilds a fork that carried a parked update', async () => {
      const { a, b } = authored()
      const journaled = journaledEngine(makeEngine())
      const source = journaled.open({ peer: '1', updates: [b] })
      const fork = journaled.fork({ handle: source.handle, peer: '2' })
      journaled.import({ handle: fork.handle, bytes: a })
      expect(await bodyOf(journaled, fork.handle)).toBe('ab')
      expect(await rebuiltBody(makeEngine, journaled.journal(fork.handle))).toBe('ab')
    })
  })
}

function describeJournalOfViewCopy(makeEngine: () => CrdtEngine) {
  it('journals a copy of a view, which has no record of its own', async () => {
    const journaled = journaledEngine(makeEngine())
    const { handle } = journaled.open({ peer: '1' })
    write(journaled, handle, 'writeMarkdownBody', { body: 'then' })
    const at = journaled.version({ handle }).frontiers
    const view = journaled.fork({ handle, peer: '2', at })
    const copy = journaled.fork({ handle: view.handle, peer: '3' })
    expect(await rebuiltBody(makeEngine, journaled.journal(copy.handle))).toBe('then')
  })
}

function describeConvergence(makeEngine: () => CrdtEngine) {
  describe('two engines that trade their local updates converge', () => {
    // A boundary between code points, in UTF-16 units: an edit that cut an
    // astral character in half names text no engine can hold.
    const boundaries = (text: string) => {
      const found: number[] = []
      let at = 0
      for (const point of text) {
        found.push(at)
        at += point.length
      }
      return [...found, at]
    }
    const pieces = fc
      .array(fc.constantFrom('a', 'b', 'é', '😀', '𝒳', '\n'), { maxLength: 4 })
      .map((chars) => chars.join(''))
    const step = fc.record({
      who: fc.constantFrom(0, 1),
      start: fc.nat(40),
      length: fc.nat(3),
      insert: pieces,
      // Whether the two sides trade everything they hold after this step.
      trade: fc.boolean(),
    })

    let runs = 0
    let concurrent = 0
    let merged = 0

    it('reach one document, each edit landing where its own view put it', async () => {
      await fc.assert(
        fc.asyncProperty(
          pieces,
          fc.array(step, { minLength: 1, maxLength: 12 }),
          async (seed, steps) => {
            const engines = [makeEngine(), makeEngine()]
            const first = engines[0] as CrdtEngine
            const handles = [first.open({ peer: '1' }).handle, 0]
            write(first, handles[0] as number, 'writeMarkdownBody', { body: seed })
            const second = engines[1] as CrdtEngine
            handles[1] = second.open({
              peer: '2',
              bytes: first.export({ handle: handles[0] as number, mode: 'snapshot' }).bytes,
            }).handle
            const outbox: string[][] = [[], []]
            const wrote = [false, false]
            let wroteBoth = false
            const trade = () => {
              for (const from of [0, 1]) {
                const to = 1 - from
                for (const bytes of outbox[from] as string[]) {
                  mutation(
                    (engines[to] as CrdtEngine).import({ handle: handles[to] as number, bytes }),
                  )
                }
                outbox[from] = []
              }
              wrote[0] = false
              wrote[1] = false
            }
            for (const { who, start, length, insert, trade: tradeNow } of steps) {
              const engine = engines[who] as CrdtEngine
              const handle = handles[who] as number
              const view = await bodyOf(engine, handle)
              const cuts = boundaries(view)
              const index = cuts[start % cuts.length] as number
              const end = cuts.filter((cut) => cut >= index)[length % 3] ?? view.length
              const result = splice(engine, handle, index, end - index, insert)
              // The model is plain string arithmetic, which counts UTF-16 units.
              expect(await bodyOf(engine, handle), 'the edit lands in its own view').toBe(
                view.slice(0, index) + insert + view.slice(end),
              )
              if (result.localUpdate !== undefined) {
                ;(outbox[who] as string[]).push(result.localUpdate)
                wrote[who] = true
              }
              if (wrote[0] === true && wrote[1] === true) wroteBoth = true
              if (tradeNow) trade()
            }
            trade()
            const left = await bodyOf(first, handles[0] as number)
            const right = await bodyOf(second, handles[1] as number)
            expect(right, 'both sides read one body').toBe(left)
            expect(held(second, handles[1] as number).toJSON()).toEqual(
              held(first, handles[0] as number).toJSON(),
            )
            runs += 1
            if (wroteBoth) {
              concurrent += 1
              // An edit of either side survived into the merged body only if the
              // merge did something other than keep one side whole.
              if (steps.some((s) => s.insert !== '' && left.includes(s.insert))) merged += 1
            }
          },
        ),
        withDefaults({ numRuns: 60 }),
      )
      expect(runs, 'cases run').toBeGreaterThan(0)
      expect(
        concurrent / runs,
        'share of cases where both sides wrote before a trade',
      ).toBeGreaterThan(0.3)
      expect(merged, 'concurrent cases whose merge kept an edit').toBeGreaterThan(15)
    })
  })
}

/**
 * Registers the conformance suite for `makeEngine`, which returns a fresh
 * engine each call. An engine's handles are its own, so each case builds the
 * engines it needs and none leans on another's.
 */
export function describeCrdtEngineConformance(makeEngine: () => CrdtEngine) {
  describe('CRDT engine conformance', () => {
    describeReadReplay(makeEngine)
    describeWriteReplay(makeEngine)
    describeExportAndImport(makeEngine)
    describeClose(makeEngine)
    describeUndoAndRedo(makeEngine)
    describeTextSpliceUtf16(makeEngine)
    describeChanged(makeEngine)
    describeRefusal(makeEngine)
    describeVersion(makeEngine)
    describeVersionDecoding(makeEngine)
    describeFork(makeEngine)
    describeViewMove(makeEngine)
    describeImportJudging(makeEngine)
    describeImportPending(makeEngine)
    describeWorkspaceSyncJudging(makeEngine)
    describeUndoHistory(makeEngine)
    describeSpliceRuns(makeEngine)
    describeSpliceRunsRefused(makeEngine)
    describeDocumentKindFallback(makeEngine)
    describeDocumentContentWithTags(makeEngine)
    describeRetiredCommentPlane(makeEngine)
    describeSubtreeImport(makeEngine)
    describeSubtreeRoot(makeEngine)
    describeReadNow(makeEngine)
    describeOpenWithUpdates(makeEngine)
    describeTrim(makeEngine)
    describeWriteJudging(makeEngine)
    describeUndoJudging(makeEngine)
    describeSpliceJudging(makeEngine)
    describeWriteJudgingThrow(makeEngine)
    describeJudgeVocabulary()
    describeSpliceWriter(makeEngine)
    describeSpliceWriterHosted(makeEngine)
    describeSpliceWriterHostedDocument(makeEngine)
    describeIndexWrites(makeEngine)
    describeSubtreeExport(makeEngine)
    describeProjectionExport(makeEngine)
    describeJournal(makeEngine)
    describeJournalOfParkedUpdates(makeEngine)
    describeJournalOfViewCopy(makeEngine)
    describeConvergence(makeEngine)
  })
}
