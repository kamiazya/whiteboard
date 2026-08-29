import { afterAll, describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../../shared/test-utils/fast-check.js'
import type { BackupSnapshot } from './backup-retention.js'
import {
  collectableFromBackup,
  sealableSnapshots,
  snapshotIsRestorable,
} from './backup-retention.js'

/**
 * ADR-0021 decision 6 states one containment and two boundaries around it, and
 * the reason it is a property rather than two unit tests is that neither
 * boundary is violated *by the step that violates it*. Sealing too early is
 * harmless until a retention pass or an expiry later removes the evidence;
 * deleting too soon is harmless until someone restores. Only a sequence
 * catches either, which is what `fc.commands` generates.
 *
 * The invariant, checked after **every** command:
 *
 *     every offered snapshot is restorable
 *     — i.e. for each offered s:  s.refs ⊆ backup
 *
 * `offered` means sealed and still within retention. That is the whole
 * guarantee an operator has: a backup the system is showing them is one they
 * can actually restore from.
 *
 * The system under test is the two predicates in `backup-retention.ts`, not a
 * simulation of them. A model-based test whose "real" side is a second copy of
 * the model asserts that a thing agrees with itself, and passes no matter what
 * either says — so the commands below call the production predicates for every
 * decision that is theirs to make, and the model tracks only the world those
 * decisions act on (which blobs exist, which are mirrored, what the document
 * references now).
 */

interface World {
  /** Blobs written, in order. The mirror copies them from here. */
  written: string[]
  /** How far the mirror has copied. Blobs before this index are in `backup`. */
  mirrored: number
  /** Where blobs live now. File-GC deletes from here and only here. */
  store: Set<string>
  /** The blob backup: append-only except through the retention pass. */
  backup: Set<string>
  /** What the live document references right now. */
  liveRefs: Set<string>
  /** Taken but not yet offered — waiting on the mirror. */
  pending: BackupSnapshot[]
  /** Sealed and within retention: what an operator may restore from. */
  offered: BackupSnapshot[]
  nextBlob: number
  nextSnapshot: number
}

function freshWorld(): World {
  return {
    written: [],
    mirrored: 0,
    store: new Set(),
    backup: new Set(),
    liveRefs: new Set(),
    pending: [],
    offered: [],
    nextBlob: 0,
    nextSnapshot: 0,
  }
}

/** Counters proving the generator reached the arrangements that matter. */
const reached = {
  seals: 0,
  retentionDeletes: 0,
  gcDeletes: 0,
  dereferences: 0,
  restores: 0,
  /** Retention ran while a snapshot with real references was on offer — the
   *  far boundary's ONLY interesting arrangement. Counting merely that
   *  retention deleted something is not enough: a mutation that deletes the
   *  whole backup went undetected by this property while that weaker counter
   *  read healthy, because every deletion happened with nothing on offer. */
  retentionUnderOffer: 0,
}

/**
 * The invariant. Asserted after every command rather than at the end, so a
 * counterexample names the step that broke it instead of the sequence that
 * contained it.
 */
function assertOfferedAreRestorable(world: World): void {
  for (const snapshot of world.offered) {
    const missing = [...snapshot.refs].filter((ref) => !world.backup.has(ref))
    expect(
      missing,
      `offered snapshot ${snapshot.id} is missing ${missing.length} blob(s) from the backup`,
    ).toEqual([])
    expect(snapshotIsRestorable(snapshot, world.backup)).toBe(true)
  }
}

/** An edit that adds an image: a new blob, referenced by the live document. */
class WriteBlobCommand implements fc.Command<World, World> {
  check(): boolean {
    return true
  }
  run(world: World): void {
    const blobId = `blob-${world.nextBlob++}`
    world.written.push(blobId)
    world.store.add(blobId)
    world.liveRefs.add(blobId)
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return 'WriteBlob'
  }
}

/**
 * An edit that REPLACES an image, so the live document stops referencing a
 * blob that older snapshots still do. Without this the far boundary is never
 * under any pressure — file-GC and the retention pass would agree on
 * everything, and the property would pass while asserting nothing about the
 * distinction ADR-0021 decision 5 draws.
 */
class DereferenceBlobCommand implements fc.Command<World, World> {
  check(world: World): boolean {
    return world.liveRefs.size > 1
  }
  run(world: World): void {
    const [first] = world.liveRefs
    if (first !== undefined) {
      world.liveRefs.delete(first)
      reached.dereferences++
    }
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return 'DereferenceBlob'
  }
}

/** The mirror copies some of what is waiting. Partial on purpose. */
class MirrorTickCommand implements fc.Command<World, World> {
  constructor(private readonly count: number) {}
  check(world: World): boolean {
    return world.mirrored < world.written.length
  }
  run(world: World): void {
    const upTo = Math.min(world.written.length, world.mirrored + this.count)
    for (let i = world.mirrored; i < upTo; i++) {
      const blobId = world.written[i]
      if (blobId !== undefined) world.backup.add(blobId)
    }
    world.mirrored = upTo
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return `MirrorTick(${this.count})`
  }
}

/**
 * The mirror drains everything waiting.
 *
 * `MirrorTick(1..3)` alone almost never lets the mirror catch up — writes
 * outpace it, so `Seal` finds nothing sealable and the whole chain past it
 * goes untested. Measured: 4 seals and 0 restores across 200 runs without
 * this command. Partial ticks stay, because a lagging mirror is what the near
 * boundary is about; this is what lets a sequence ever get past it.
 */
class MirrorCatchUpCommand implements fc.Command<World, World> {
  check(world: World): boolean {
    return world.mirrored < world.written.length
  }
  run(world: World): void {
    for (let i = world.mirrored; i < world.written.length; i++) {
      const blobId = world.written[i]
      if (blobId !== undefined) world.backup.add(blobId)
    }
    world.mirrored = world.written.length
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return 'MirrorCatchUp'
  }
}

/** A row snapshot: pins what the document references at this instant. */
class TakeSnapshotCommand implements fc.Command<World, World> {
  /** A snapshot referencing nothing is trivially restorable under every
   *  backup, so it contributes nothing here and crowds out the sequences that
   *  do. Measured: without this, the property missed a mutation that deleted
   *  the entire blob backup. */
  check(world: World): boolean {
    return world.liveRefs.size > 0
  }
  run(world: World): void {
    world.pending.push({
      id: `snap-${world.nextSnapshot++}`,
      refs: new Set(world.liveRefs),
    })
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return 'TakeSnapshot'
  }
}

/** The near boundary, decided by the production predicate. */
class SealCommand implements fc.Command<World, World> {
  check(world: World): boolean {
    return world.pending.length > 0
  }
  run(world: World): void {
    const sealable = sealableSnapshots(world.pending, world.backup)
    const sealedIds = new Set(sealable.map((snapshot) => snapshot.id))
    world.pending = world.pending.filter((snapshot) => !sealedIds.has(snapshot.id))
    world.offered.push(...sealable)
    reached.seals += sealable.length
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return 'Seal'
  }
}

/**
 * One complete backup cycle: write, let the mirror catch up, snapshot, seal.
 *
 * The fine-grained commands can express this, and measurably almost never do
 * — generated sequences average about five executed commands, and this chain
 * needs five specific ones in the right order. Measured without it: 6 sealed
 * snapshots and **0 restores** across 200 runs, with a mutation that deletes
 * the entire blob backup going undetected.
 *
 * This is a real operation rather than a shortcut through the model: it is
 * what a scheduled pass does end to end, and every decision inside it is
 * still made by the production predicate. The fine-grained commands stay,
 * because interleaving them around this one is what puts the boundaries under
 * adversarial ordering.
 */
class CompleteBackupCycleCommand implements fc.Command<World, World> {
  check(world: World): boolean {
    return world.liveRefs.size > 0 || world.written.length === 0
  }
  run(world: World): void {
    // A REPLACEMENT past the first couple, not an accumulation. If every
    // cycle only added a reference, each new snapshot would reference every
    // blob any older one did, nothing would ever become collectable, and the
    // far boundary would never come under test — measured: 0 retention
    // deletions under offer across 200 runs.
    if (world.liveRefs.size >= 2) {
      const [oldest] = world.liveRefs
      if (oldest !== undefined) world.liveRefs.delete(oldest)
    }
    const blobId = `blob-${world.nextBlob++}`
    world.written.push(blobId)
    world.store.add(blobId)
    world.liveRefs.add(blobId)
    for (let i = world.mirrored; i < world.written.length; i++) {
      const queued = world.written[i]
      if (queued !== undefined) world.backup.add(queued)
    }
    world.mirrored = world.written.length
    const snapshot: BackupSnapshot = {
      id: `snap-${world.nextSnapshot++}`,
      refs: new Set(world.liveRefs),
    }
    const sealed = sealableSnapshots([snapshot], world.backup)
    world.offered.push(...sealed)
    reached.seals += sealed.length
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return 'CompleteBackupCycle'
  }
}

/**
 * File-GC, over the blob STORE.
 *
 * It deletes from `store` and asserts `backup` is untouched — ADR-0021
 * decision 5's separation, stated as something that can actually fail. The
 * first version of this command mutated nothing at all, which made its
 * assertion vacuous; the deletion is what gives it a subject.
 */
class FileGcCommand implements fc.Command<World, World> {
  check(world: World): boolean {
    return world.store.size > 0
  }
  run(world: World): void {
    const backupBefore = new Set(world.backup)
    const collectable = [...world.store].filter((blobId) => !world.liveRefs.has(blobId))
    // GC really deletes, and only from the store. Without the deletion this
    // command mutated nothing, so the assertion below compared `backup` with
    // a clone taken two lines earlier and could not fail — a guard reading as
    // coverage while having no subject at all.
    for (const blobId of collectable) world.store.delete(blobId)
    reached.gcDeletes += collectable.length
    // The backup is not GC's business. THIS is what decision 5 asks of it.
    expect([...world.backup].sort()).toEqual([...backupBefore].sort())
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return 'FileGc'
  }
}

/** The far boundary, decided by the production predicate. */
class RetentionPassCommand implements fc.Command<World, World> {
  check(world: World): boolean {
    return world.backup.size > 0
  }
  run(world: World): void {
    const underOffer = world.offered.some((snapshot) => snapshot.refs.size > 0)
    const collectable = collectableFromBackup(world.backup, world.offered)
    for (const blobId of collectable) world.backup.delete(blobId)
    reached.retentionDeletes += collectable.length
    if (underOffer && collectable.length > 0) reached.retentionUnderOffer++
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return 'RetentionPass'
  }
}

/** A snapshot leaves retention and stops being offered. */
class ExpireSnapshotCommand implements fc.Command<World, World> {
  check(world: World): boolean {
    return world.offered.length > 0
  }
  run(world: World): void {
    world.offered.shift()
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return 'ExpireSnapshot'
  }
}

/** What an operator actually does, asserted end to end. */
class RestoreCommand implements fc.Command<World, World> {
  check(world: World): boolean {
    return world.offered.length > 0
  }
  run(world: World): void {
    for (const snapshot of world.offered) {
      expect(snapshotIsRestorable(snapshot, world.backup)).toBe(true)
      reached.restores++
    }
    assertOfferedAreRestorable(world)
  }
  toString(): string {
    return 'Restore'
  }
}

/**
 * Density is deliberate. Writes and mirror ticks outnumber the rest because
 * every interesting arrangement needs blobs that exist and a mirror that lags
 * behind them; a uniform distribution spends most sequences on passes with
 * nothing to act on. `afterAll` is what proves this actually landed — a
 * generator too sparse to reach a retention deletion would pass vacuously and
 * read exactly like a guarantee.
 */
const allCommands = [
  fc.constant(new CompleteBackupCycleCommand()),
  fc.constant(new CompleteBackupCycleCommand()),
  fc.constant(new CompleteBackupCycleCommand()),
  fc.constant(new WriteBlobCommand()),
  fc.constant(new WriteBlobCommand()),
  fc.constant(new WriteBlobCommand()),
  fc.constant(new DereferenceBlobCommand()),
  fc.constant(new DereferenceBlobCommand()),
  fc.integer({ min: 1, max: 3 }).map((n) => new MirrorTickCommand(n)),
  fc.constant(new MirrorCatchUpCommand()),
  fc.constant(new MirrorCatchUpCommand()),
  fc.constant(new TakeSnapshotCommand()),
  fc.constant(new TakeSnapshotCommand()),
  fc.constant(new SealCommand()),
  fc.constant(new SealCommand()),
  fc.constant(new SealCommand()),
  fc.constant(new FileGcCommand()),
  fc.constant(new RetentionPassCommand()),
  fc.constant(new ExpireSnapshotCommand()),
  fc.constant(new ExpireSnapshotCommand()),
  fc.constant(new RetentionPassCommand()),
  fc.constant(new RestoreCommand()),
  fc.constant(new RestoreCommand()),
]

describe('ADR-0021 decision 6: an offered backup is a restorable backup', () => {
  afterAll(() => {
    // Non-vacuity. Each of these is an arrangement the property would silently
    // stop covering if the generator drifted, and the failure mode of that is
    // a green test asserting nothing.
    expect(reached.seals, 'no snapshot was ever sealed').toBeGreaterThan(0)
    expect(reached.restores, 'no snapshot was ever restored').toBeGreaterThan(0)
    expect(
      reached.dereferences,
      'no blob was ever dereferenced, so the backup and the live document never disagreed',
    ).toBeGreaterThan(0)
    expect(
      reached.gcDeletes,
      'file-GC never had anything to collect, so its separation from the backup was never exercised',
    ).toBeGreaterThan(0)
    expect(
      reached.retentionDeletes,
      'the retention pass never deleted anything, so the far boundary was never under pressure',
    ).toBeGreaterThan(0)
    expect(
      reached.retentionUnderOffer,
      'retention never ran while a snapshot with real references was on offer — the far boundary is untested',
    ).toBeGreaterThan(0)
  })

  fcTest.prop(
    [fc.commands(allCommands, { maxCommands: 40, size: '+2' })],
    withDefaults({ numRuns: 200 }),
  )(
    'holds under any interleaving of writes, mirroring, sealing, GC, retention and expiry',
    (commands) => {
      fc.modelRun(() => {
        const world = freshWorld()
        return { model: world, real: world }
      }, commands)
    },
  )
})

/**
 * The shrunk counterexamples the property found, pinned as examples.
 *
 * Per the repo's rule: the example is the regression guard, the property is
 * the generator that found it. These two are the minimal sequences that break
 * each boundary, and each is one command long past its setup — which is the
 * argument for the property, since neither is visible at the step that causes
 * it.
 */
describe('the two boundaries, as the minimal sequences that break them', () => {
  it_near()
  it_far()
})

function it_near(): void {
  fcTest('sealing before the mirror arrives offers a snapshot that cannot be restored', () => {
    const backup = new Set<string>()
    const snapshot: BackupSnapshot = { id: 'snap-0', refs: new Set(['blob-0']) }

    // The mirror has not copied blob-0 yet, so this snapshot is not sealable.
    expect(sealableSnapshots([snapshot], backup)).toEqual([])
    expect(snapshotIsRestorable(snapshot, backup)).toBe(false)

    // Once it has, it is.
    backup.add('blob-0')
    expect(sealableSnapshots([snapshot], backup)).toEqual([snapshot])
    expect(snapshotIsRestorable(snapshot, backup)).toBe(true)
  })
}

function it_far(): void {
  fcTest('a blob the live document replaced is still held by the snapshot that used it', () => {
    const backup = new Set(['blob-0', 'blob-1'])
    // The document has moved on to blob-1; an offered snapshot still uses blob-0.
    const offered: BackupSnapshot = { id: 'snap-0', refs: new Set(['blob-0']) }

    // Retention keeps blob-0 precisely because a snapshot on offer needs it —
    // liveness in the current document would have collected it.
    expect(collectableFromBackup(backup, [offered])).toEqual(['blob-1'])
    expect(snapshotIsRestorable(offered, backup)).toBe(true)

    // Once nothing is on offer, everything is collectable.
    expect(collectableFromBackup(backup, []).sort()).toEqual(['blob-0', 'blob-1'])
  })
}
