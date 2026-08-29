import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  DocumentStore,
  SaveCompactedSnapshotInput,
  SaveCompactedSnapshotResult,
} from '@kamiazya/whiteboard-ports'
import { DocumentStoreWorkspaceDocs } from '@kamiazya/whiteboard-workspace-index'
import { LoroDoc } from 'loro-crdt'
import { afterAll, describe, expect } from 'vitest'
import { fc, fcTest } from '../../shared/test-utils/fast-check.js'
import { createIsolatedDb } from './db/test-helpers.js'
import { InMemoryDocumentStore } from './inmemory/in-memory-document-store.js'
import { LibsqlDocumentStore } from './libsql/libsql-document-store.js'

/**
 * ADR-0020's data-plane claim, as a property rather than an argument.
 *
 * The ADR asserts that several server processes may write one workspace record
 * without coordinating, and that they converge. Every example test around it
 * pins one arrangement someone thought of; this generates the arrangements.
 *
 * The model is N INSTANCES over ONE store, each holding its own `LoroDoc` —
 * which is what a second daemon process, or a second browser tab, actually is.
 * The hazard is not that the two write at the same instant; it is that each
 * one's doc is BEHIND the record when it writes. That is reproduced exactly by
 * running commands in order against instances whose docs are never refreshed,
 * and it shrinks, which a wall-clock race does not.
 *
 * The fence needs one more thing, and it is the reason `saveBoth` exists:
 * a compare-and-swap can only be REFUSED when one writer's read and write
 * straddle another's write. Sequential commands never straddle — each `save`
 * runs to completion before the next begins — so a purely sequential model
 * would exercise convergence and leave the fence untouched while looking like
 * it covered both. `afterAll` asserts both actually happened.
 */

const WORKSPACE = 'ws-convergence'

/** Past `COMPACT_DELTA_BYTES` (64 KiB) on its own, so an edit carrying one
 *  drives the next save down the FOLD path instead of the plain append. The
 *  fold is where the lost update lived, so a generator that never produced a
 *  value this size would pass while testing the half that was never broken. */
const BIG_VALUE = 'x'.repeat(70 * 1024)

interface Stats {
  folds: number
  refusals: number
}

/** Counts what the generator actually reached, so a sequence distribution that
 *  stops producing folds or straddled saves fails loudly instead of quietly
 *  testing less than it claims. */
function countingStore(inner: DocumentStore, stats: Stats): DocumentStore {
  return {
    loadSnapshot: (input) => inner.loadSnapshot(input),
    readSnapshotManifest: (input) => inner.readSnapshotManifest(input),
    saveSnapshot: (input) => inner.saveSnapshot(input),
    async saveCompactedSnapshot(
      input: SaveCompactedSnapshotInput,
    ): Promise<SaveCompactedSnapshotResult> {
      const result = await inner.saveCompactedSnapshot(input)
      if (result.ok) stats.folds += 1
      else stats.refusals += 1
      return result
    },
    appendDeltas: (input) => inner.appendDeltas(input),
    loadDeltas: (input) => inner.loadDeltas(input),
    readFrontier: (input) => inner.readFrontier(input),
    deleteDoc: (input) => inner.deleteDoc(input),
  }
}

type Command =
  | { type: 'edit'; instance: number; big: boolean }
  | { type: 'save'; instance: number }
  /** Two instances save with their reads and writes straddling each other —
   *  the only shape that can refuse a fold. */
  | { type: 'saveBoth'; a: number; b: number }
  /** Drop this instance's doc and re-read the record: a cache eviction, a
   *  restarted process, or a reloaded tab. */
  | { type: 'reopen'; instance: number }

const INSTANCE_COUNT = 3

const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  fc.record({
    type: fc.constant('edit' as const),
    instance: fc.integer({ min: 0, max: INSTANCE_COUNT - 1 }),
    // Weighted toward big: a small edit appends, and only a fold can be
    // refused. An even split left folds rare enough that a whole run could
    // miss them.
    big: fc.boolean(),
  }),
  fc.record({
    type: fc.constant('save' as const),
    instance: fc.integer({ min: 0, max: INSTANCE_COUNT - 1 }),
  }),
  fc.record({
    type: fc.constant('saveBoth' as const),
    a: fc.integer({ min: 0, max: INSTANCE_COUNT - 1 }),
    b: fc.integer({ min: 0, max: INSTANCE_COUNT - 1 }),
  }),
  fc.record({
    type: fc.constant('reopen' as const),
    instance: fc.integer({ min: 0, max: INSTANCE_COUNT - 1 }),
  }),
)

describe('multi-instance convergence (ADR-0020)', () => {
  const stats: Stats = { folds: 0, refusals: 0 }

  /**
   * The fixture reached its subject.
   *
   * Without this, a generator that drifted away from folds — a narrower
   * `big`, a shorter sequence, a changed compaction budget — would keep
   * passing while covering only the append path, and the pass would read as
   * evidence for a fence it never touched.
   */
  afterAll(() => {
    expect(stats.folds).toBeGreaterThan(0)
    expect(stats.refusals).toBeGreaterThan(0)
  })

  async function runProperty(
    commands: readonly Command[],
    makeStore: () => Promise<{ store: DocumentStore; dispose: () => Promise<void> }>,
  ): Promise<void> {
    const { store: raw, dispose } = await makeStore()
    const store = countingStore(raw, stats)
    const docs = new DocumentStoreWorkspaceDocs(store)
    try {
      const instances: LoroDoc[] = Array.from({ length: INSTANCE_COUNT }, () => new LoroDoc())
      // Edits this instance has made but not yet persisted. Dropped on reopen,
      // because an edit nobody saved is not an acknowledged write.
      const pending: Set<string>[] = Array.from({ length: INSTANCE_COUNT }, () => new Set())
      // Every key some `save` reported success for. This is the model: the
      // record must hold exactly these, no matter how the writes interleaved.
      const acknowledged = new Set<string>()
      let nextKey = 0

      const save = async (index: number): Promise<void> => {
        const doc = instances[index]
        if (doc === undefined) return
        await docs.save(WORKSPACE, doc)
        for (const key of pending[index] ?? []) acknowledged.add(key)
        pending[index]?.clear()
      }

      for (const command of commands) {
        if (command.type === 'edit') {
          const key = `k${nextKey++}`
          instances[command.instance]?.getMap('meta').set(key, command.big ? BIG_VALUE : key)
          instances[command.instance]?.commit()
          pending[command.instance]?.add(key)
        } else if (command.type === 'save') {
          await save(command.instance)
        } else if (command.type === 'saveBoth') {
          // Started before either is awaited, so the second instance's read
          // happens before the first instance's write.
          await Promise.all([save(command.a), save(command.b)])
        } else {
          const reopened = await docs.open(WORKSPACE)
          instances[command.instance] = reopened ?? new LoroDoc()
          pending[command.instance]?.clear()
        }
      }

      const settled = (await docs.open(WORKSPACE)) ?? new LoroDoc()
      const stored = settled.getMap('meta').toJSON() as Record<string, unknown>

      // No acknowledged write is missing, and nothing is present that no save
      // ever reported — the two halves of "the record is exactly what was
      // written to it".
      expect(new Set(Object.keys(stored))).toEqual(acknowledged)

      // And every instance agrees once it re-reads: convergence, not merely
      // durability.
      for (let index = 0; index < INSTANCE_COUNT; index += 1) {
        const peer = (await docs.open(WORKSPACE)) ?? new LoroDoc()
        expect(peer.getMap('meta').toJSON()).toEqual(stored)
      }
    } finally {
      await dispose()
    }
  }

  fcTest.prop([fc.array(commandArbitrary, { minLength: 4, maxLength: 14 })], { numRuns: 40 })(
    'no acknowledged write is lost, whatever order instances with stale docs write in',
    async (commands) => {
      await runProperty(commands, async () => ({
        store: new InMemoryDocumentStore(),
        dispose: async () => {},
      }))
    },
  )

  fcTest.prop([fc.array(commandArbitrary, { minLength: 4, maxLength: 12 })], { numRuns: 12 })(
    'the same holds against the real libSQL store, transactions and all',
    async (commands) => {
      await runProperty(commands, async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-convergence-'))
        const handle = await createIsolatedDb({ dataDir })
        return {
          store: new LibsqlDocumentStore(handle.db),
          dispose: async () => {
            await handle.dispose()
            await rm(dataDir, { recursive: true, force: true })
          },
        }
      })
    },
  )
})
