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
 * ADR-0020's data-plane claim, as a model-based property rather than an
 * argument.
 *
 * The ADR asserts that several server processes may write one workspace record
 * without coordinating, and that they converge. Every example test around it
 * pins one arrangement someone thought of; this generates the arrangements,
 * and the first thing it did was fail on one nobody had.
 *
 * The subject is N INSTANCES over ONE store, each holding its own `LoroDoc` —
 * which is what a second daemon process, or a second browser tab, actually is.
 * The hazard is not that two writers act at the same instant; it is that each
 * one's doc is BEHIND the record when it writes. That is reproduced exactly by
 * instances whose docs are never refreshed, and it shrinks, which a wall-clock
 * race does not.
 *
 * The fence needs one more thing, and it is the whole reason
 * `ConcurrentSaveCommand` exists: a compare-and-swap can only be REFUSED when
 * one writer's read and write straddle another's write. Commands run in order,
 * and an ordered model never straddles — each save completes before the next
 * begins — so a purely sequential model would exercise convergence, leave the
 * fence untouched, and look like it covered both. `afterAll` asserts both
 * actually happened.
 */

const WORKSPACE = 'ws-convergence'

/** Past `COMPACT_DELTA_BYTES` (64 KiB) on its own, so an edit carrying one
 *  drives the next save down the FOLD path instead of the plain append. The
 *  fold is where both lost updates lived, so a generator that never produced
 *  a value this size would pass while testing the half that was never broken. */
const BIG_VALUE = 'x'.repeat(70 * 1024)

const INSTANCE_COUNT = 3

/**
 * What the record OUGHT to hold, and nothing about how it holds it.
 *
 * `acknowledged` is the specification: a key enters it when a `save` returns,
 * and from that moment the record must contain it under every subsequent
 * command. `pending` is per-instance bookkeeping, not a claim — an edit nobody
 * saved is not an acknowledged write, which is why a reopen discards it.
 */
interface Model {
  acknowledged: Set<string>
  pending: Set<string>[]
  nextKey: number
}

interface Real {
  docs: DocumentStoreWorkspaceDocs
  instances: LoroDoc[]
  hook: { current: BeforeFoldWrite }
}

interface Stats {
  folds: number
  refusals: number
  straddles: number
}

/**
 * Fires once, immediately before a fold's write reaches the store, and is
 * cleared as it fires.
 *
 * This is the only way this model can produce the interleaving the fence
 * exists for. `Promise.all` over two saves does interleave, but in microtask
 * lockstep the second writer's `loadSnapshot` lands AFTER the first writer's
 * write — so its fold already contains the other's ops and nothing is lost
 * even with the fence removed. Measured: with the fence disabled, the
 * convergence assertions stayed green and only the reach counters moved.
 *
 * Real processes have no such lockstep; a read can precede another process's
 * write by any amount. `StraddledSaveCommand` reproduces that ordering
 * deterministically instead of hoping for it.
 */
type BeforeFoldWrite = (() => Promise<void>) | undefined

/** Counts what the generator actually reached, so a distribution that stops
 *  producing folds or straddled saves fails loudly instead of quietly testing
 *  less than it claims. */
function countingStore(
  inner: DocumentStore,
  stats: Stats,
  hook: { current: BeforeFoldWrite },
): DocumentStore {
  return {
    loadSnapshot: (input) => inner.loadSnapshot(input),
    readSnapshotManifest: (input) => inner.readSnapshotManifest(input),
    saveSnapshot: (input) => inner.saveSnapshot(input),
    async saveCompactedSnapshot(
      input: SaveCompactedSnapshotInput,
    ): Promise<SaveCompactedSnapshotResult> {
      const pending = hook.current
      if (pending !== undefined) {
        hook.current = undefined
        stats.straddles += 1
        await pending()
      }
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

/**
 * The invariant, checked after EVERY command rather than once at the end.
 *
 * Checking only the final state says a sequence broke and leaves which
 * command broke it to be worked out from a JSON dump. Checking each step
 * makes the failing command the last one printed, and the model's own
 * `toString` names it.
 */
async function assertRecordMatchesModel(model: Model, real: Real): Promise<void> {
  const record = (await real.docs.open(WORKSPACE)) ?? new LoroDoc()
  const keys = new Set(Object.keys(record.getMap('meta').toJSON() as Record<string, unknown>))
  // Both directions: no acknowledged write is missing, and nothing is present
  // that no save ever reported. Either half alone passes against a store that
  // fails the other way.
  expect(keys).toEqual(model.acknowledged)
}

class EditCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    private readonly instance: number,
    private readonly big: boolean,
  ) {}

  // Every command below is applicable in every state — an idle save, a reopen
  // of a record that does not exist yet, and an edit on a cold doc are all
  // real things a process does. Saying so here beats inventing a
  // precondition that only narrows what the property reaches.
  check(): boolean {
    return true
  }

  async run(model: Model, real: Real): Promise<void> {
    const key = `k${model.nextKey++}`
    const doc = real.instances[this.instance]
    doc?.getMap('meta').set(key, this.big ? BIG_VALUE : key)
    doc?.commit()
    model.pending[this.instance]?.add(key)
    await assertRecordMatchesModel(model, real)
  }

  toString(): string {
    return `edit(instance=${this.instance}, ${this.big ? 'big' : 'small'})`
  }
}

async function persist(model: Model, real: Real, instance: number): Promise<void> {
  const doc = real.instances[instance]
  if (doc === undefined) return
  await real.docs.save(WORKSPACE, doc)
  for (const key of model.pending[instance] ?? []) model.acknowledged.add(key)
  model.pending[instance]?.clear()
}

class SaveCommand implements fc.AsyncCommand<Model, Real> {
  constructor(private readonly instance: number) {}

  check(): boolean {
    return true
  }

  async run(model: Model, real: Real): Promise<void> {
    await persist(model, real, this.instance)
    await assertRecordMatchesModel(model, real)
  }

  toString(): string {
    return `save(instance=${this.instance})`
  }
}

/**
 * Two instances save with their reads and writes straddling each other. The
 * only shape in this model that can refuse a fold, and therefore the only one
 * that reaches the generation fence at all.
 */
class ConcurrentSaveCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    private readonly a: number,
    private readonly b: number,
  ) {}

  check(): boolean {
    return true
  }

  async run(model: Model, real: Real): Promise<void> {
    // Both started before either is awaited, so the second instance's read
    // happens before the first instance's write.
    await Promise.all([persist(model, real, this.a), persist(model, real, this.b)])
    await assertRecordMatchesModel(model, real)
  }

  toString(): string {
    return `saveConcurrently(${this.a}, ${this.b})`
  }
}

/**
 * Two instances fold, with `b`'s entire fold landing inside the window between
 * `a` reading the record and `a` writing its own.
 *
 * This is the arrangement a compare-and-swap is FOR, and it is the ONLY one
 * that loses an op without one: when `b` merely APPENDS inside that window,
 * `supersededDeltaCount` already protects it — `a` drops exactly the prefix it
 * folded and `b`'s delta survives. The loss needs `b` to REPLACE the snapshot,
 * after which `a`'s write puts back a record that never contained `b`'s ops.
 *
 * So this command supplies the conjunction rather than waiting for it: both
 * instances take an edit large enough to fold, and then the folds straddle.
 * Measured on the way here — with only a plain straddle, and with only
 * `Promise.all` concurrency, disabling the fence left every convergence
 * assertion green and moved nothing but the reach counters. A command that
 * cannot produce the arrangement its name claims is worse than no command,
 * because the counters make it look covered.
 */
class StraddledFoldCommand implements fc.AsyncCommand<Model, Real> {
  constructor(
    private readonly a: number,
    private readonly b: number,
  ) {}

  // Two DIFFERENT instances: straddling an instance against itself is a
  // re-entrant save of one doc, which is a different thing and already
  // covered by the plain save commands.
  check(): boolean {
    return this.a !== this.b
  }

  async run(model: Model, real: Real): Promise<void> {
    for (const instance of [this.a, this.b]) {
      const key = `k${model.nextKey++}`
      real.instances[instance]?.getMap('meta').set(key, BIG_VALUE)
      real.instances[instance]?.commit()
      model.pending[instance]?.add(key)
    }
    real.hook.current = async () => {
      await persist(model, real, this.b)
    }
    try {
      await persist(model, real, this.a)
    } finally {
      real.hook.current = undefined
    }
    await assertRecordMatchesModel(model, real)
  }

  toString(): string {
    return `foldsStraddled(folding=${this.a}, interleaved=${this.b})`
  }
}

/** Drop this instance's doc and re-read the record: a cache eviction, a
 *  restarted process, or a reloaded tab. */
class ReopenCommand implements fc.AsyncCommand<Model, Real> {
  constructor(private readonly instance: number) {}

  check(): boolean {
    return true
  }

  async run(model: Model, real: Real): Promise<void> {
    real.instances[this.instance] = (await real.docs.open(WORKSPACE)) ?? new LoroDoc()
    // Unsaved edits die with the doc that held them, so they were never
    // acknowledged and the model must stop expecting them.
    model.pending[this.instance]?.clear()
    await assertRecordMatchesModel(model, real)
  }

  toString(): string {
    return `reopen(instance=${this.instance})`
  }
}

const instanceArbitrary = fc.integer({ min: 0, max: INSTANCE_COUNT - 1 })

/**
 * Weighted, and the weights are load-bearing rather than taste.
 *
 * The defect this property exists to catch needs a specific arrangement: an
 * instance whose doc is behind the record performs a FOLD. Only a big edit
 * reaches the fold path, and only a save on that same instance triggers it, so
 * under a uniform draw over four command kinds the arrangement is dilute
 * enough to miss. Measured: with a uniform generator and no seeded record, 40
 * runs did not find the partial-view fold at all, and 300 runs did. Raising
 * `numRuns` is the wrong fix for that — it pays for the same sparse search —
 * so the density is here instead, and `afterAll` proves it still lands.
 */
const allCommands = [
  fc
    .tuple(instanceArbitrary, fc.integer({ min: 0, max: 2 }))
    .map(([i, size]) => new EditCommand(i, size > 0)),
  instanceArbitrary.map((i) => new SaveCommand(i)),
  fc.tuple(instanceArbitrary, instanceArbitrary).map(([a, b]) => new ConcurrentSaveCommand(a, b)),
  fc.tuple(instanceArbitrary, instanceArbitrary).map(([a, b]) => new StraddledFoldCommand(a, b)),
  // Rarest on purpose: a reopen REMOVES staleness, which is the very
  // condition under test.
  instanceArbitrary.map((i) => new ReopenCommand(i)),
]

describe('multi-instance convergence (ADR-0020)', () => {
  const stats: Stats = { folds: 0, refusals: 0, straddles: 0 }

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
    expect(stats.straddles).toBeGreaterThan(0)
  })

  /**
   * Seeds the record from a writer that is NOT one of the instances, so every
   * instance begins stale with respect to content that already exists.
   *
   * That is the ordinary state of a process joining a workspace someone else
   * has been editing, and it is also the precondition the hazard needs. Left
   * to the random search, "the record already holds another writer's ops"
   * had to be rebuilt from scratch in every sequence, which is most of why
   * the uniform generator missed.
   */
  async function freshState(
    store: DocumentStore,
    hook: { current: BeforeFoldWrite },
  ): Promise<{ model: Model; real: Real }> {
    const docs = new DocumentStoreWorkspaceDocs(store)
    const seeder = new LoroDoc()
    seeder.getMap('meta').set('seed', 'seed')
    seeder.commit()
    await docs.save(WORKSPACE, seeder)
    return {
      model: {
        acknowledged: new Set(['seed']),
        pending: Array.from({ length: INSTANCE_COUNT }, () => new Set<string>()),
        nextKey: 0,
      },
      real: {
        docs,
        instances: Array.from({ length: INSTANCE_COUNT }, () => new LoroDoc()),
        hook,
      },
    }
  }

  fcTest.prop([fc.commands(allCommands, { maxCommands: 14 })], { numRuns: 40 })(
    'no acknowledged write is lost, whatever order instances with stale docs write in',
    async (commands) => {
      const hook: { current: BeforeFoldWrite } = { current: undefined }
      const store = countingStore(new InMemoryDocumentStore(), stats, hook)
      await fc.asyncModelRun(() => freshState(store, hook), commands)
    },
  )

  fcTest.prop([fc.commands(allCommands, { maxCommands: 12 })], { numRuns: 12 })(
    'the same holds against the real libSQL store, transactions and all',
    async (commands) => {
      const dataDir = await mkdtemp(join(tmpdir(), 'whiteboard-convergence-'))
      const handle = await createIsolatedDb({ dataDir })
      try {
        const hook: { current: BeforeFoldWrite } = { current: undefined }
        const store = countingStore(new LibsqlDocumentStore(handle.db), stats, hook)
        await fc.asyncModelRun(() => freshState(store, hook), commands)
      } finally {
        await handle.dispose()
        await rm(dataDir, { recursive: true, force: true })
      }
    },
  )
})
