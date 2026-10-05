/**
 * What the "saved / pending / degraded" indicator may say, under any
 * interleaving of the events that decide it.
 *
 * The model is written as an EVENT LOG read back after each step, not as the
 * ledger's counters: whether a failure is still outstanding is answered by
 * scanning the log for a later landing, or a later push that began after the
 * failure and ended with none arriving meanwhile. The ledger answers the same
 * question with an epoch counter, so a bug in the counter is a disagreement
 * rather than a shared mistake.
 *
 * Two layers are checked after every command. The prediction: exactly which
 * report kinds this command produces. And three safety statements judged on
 * the reports that actually arrived, independent of the prediction — `saved`
 * is never said while a push is in flight, the session is busy, or a failure
 * is unanswered; the first report after quiet is `pending`; `lastSavedAt`
 * only changes by a `saved`.
 *
 * The settling commands are the ones the session settles after: a push
 * resolving, a landing, and the post-commit check. Everything else must
 * produce no `saved`, which is what keeps "pending forever" and "saved too
 * early" from cancelling each other out.
 */
import { afterAllFloor } from '@kamiazya/whiteboard-model/test-utils'
import { afterAll, beforeAll, describe, expect } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import type { BrowserPersistenceState } from './browser-persistence-state.js'
import { PersistenceLedger } from './persistence-ledger.js'

type Handle = ReturnType<PersistenceLedger['pushStarted']>
/** What this ledger reports: it has no path that reports `saving`. */
type Kind = Exclude<BrowserPersistenceState['kind'], 'saving'>

type Entry =
  | { event: 'edit' }
  | { event: 'start'; id: number }
  | { event: 'resolve'; startedAt: number }
  | { event: 'failure' }
  | { event: 'landed' }

interface Model {
  log: Entry[]
  /** Pushes in flight, by id. */
  open: number[]
  nextId: number
  everStarted: boolean
  /** An edit or a failure has happened since the last `saved` (or ever). */
  dirty: boolean
  /** A failure re-opened a document that had settled, and no `saved` has followed. */
  reopened: boolean
  busy: boolean
}

interface Real {
  ledger: PersistenceLedger
  reports: BrowserPersistenceState[]
  handles: Map<number, Handle>
  busy: boolean
}

/** What a run actually produced, counted as effects rather than attempts. */
const emptyTally = () => ({
  pending: 0,
  saved: 0,
  degraded: 0,
  silentStorageFailures: 0,
  failuresAfterSaved: 0,
  resavedAfterSettledFailure: 0,
  recoveredByLanding: 0,
  recoveredByCleanPush: 0,
  epochRuleHeld: 0,
  blockedByBusy: 0,
  blockedByInFlight: 0,
  droppedPushes: 0,
  overlappingPushes: 0,
})
let tally = emptyTally()

function failureOutstanding(log: readonly Entry[]): boolean {
  let last = -1
  log.forEach((entry, index) => {
    if (entry.event === 'failure') last = index
  })
  if (last < 0) return false
  return !log
    .slice(last + 1)
    .some(
      (entry) => entry.event === 'landed' || (entry.event === 'resolve' && entry.startedAt > last),
    )
}

function newSession(): { model: Model; real: Real } {
  const reports: BrowserPersistenceState[] = []
  const real: Real = {
    reports,
    handles: new Map(),
    busy: false,
    ledger: new PersistenceLedger(
      (state) => reports.push(state),
      () => real.busy,
    ),
  }
  const model: Model = {
    log: [],
    open: [],
    nextId: 0,
    everStarted: false,
    dirty: false,
    reopened: false,
    busy: false,
  }
  return { model, real }
}

const kindsSince = (real: Real, from: number): BrowserPersistenceState['kind'][] =>
  real.reports.slice(from).map((report) => report.kind)

/** Judged on the reports themselves, whatever the prediction says. */
function judgeSafety(model: Model, real: Real, from: number): void {
  const lastSavedBefore = real.reports
    .slice(0, from)
    .reverse()
    .find((report) => report.kind === 'saved')
  let lastSavedAt = lastSavedBefore?.lastSavedAt ?? null
  let previousKind: BrowserPersistenceState['kind'] | undefined = real.reports[from - 1]?.kind
  for (const report of real.reports.slice(from)) {
    if (report.kind === 'saved') {
      expect(model.open, 'saved while a push was in flight').toEqual([])
      expect(model.busy, 'saved while the session was busy').toBe(false)
      expect(failureOutstanding(model.log), 'saved with a failure unanswered').toBe(false)
      expect(previousKind, 'saved straight after saved: nothing was edited').not.toBe('saved')
      expect(report.lastSavedAt).not.toBeNull()
      lastSavedAt = report.lastSavedAt
    } else {
      expect(report.lastSavedAt, `${report.kind} must carry the last saved time`).toBe(lastSavedAt)
    }
    if (report.kind === 'pending') {
      expect(
        previousKind === undefined || previousKind === 'saved',
        'pending is the first report after quiet, never after another unsaved report',
      ).toBe(true)
    }
    previousKind = report.kind
  }
}

abstract class Step implements fc.Command<Model, Real> {
  abstract readonly label: string
  /** Whether the session settles after this step, so a `saved` may follow. */
  protected readonly settles: boolean = false
  check(_model: Readonly<Model>): boolean {
    return true
  }
  /** Perform on the real ledger and record in the model; answer what it must report. */
  protected abstract apply(model: Model, real: Real): Kind[]
  run(model: Model, real: Real): void {
    const from = real.reports.length
    const expected = this.apply(model, real)
    if (this.settles) expected.push(...this.settleExpectation(model))
    expect(kindsSince(real, from), `after ${this.label}`).toEqual(expected)
    judgeSafety(model, real, from)
    for (const kind of expected) tally[kind]++
  }
  /** The post-commit check: saved iff dirty, quiet, and no failure unanswered. */
  private settleExpectation(model: Model): Kind[] {
    if (!model.dirty || failureOutstanding(model.log)) return []
    if (model.open.length > 0) {
      tally.blockedByInFlight++
      return []
    }
    if (model.busy) {
      tally.blockedByBusy++
      return []
    }
    model.dirty = false
    if (model.reopened) tally.resavedAfterSettledFailure++
    model.reopened = false
    return ['saved']
  }
  toString(): string {
    return this.label
  }
}

class Edit extends Step {
  readonly label = 'edited'
  protected apply(model: Model, real: Real): Kind[] {
    real.ledger.edited()
    model.log.push({ event: 'edit' })
    if (model.dirty) return []
    model.dirty = true
    return ['pending']
  }
}

class StartPush extends Step {
  readonly label = 'pushStarted'
  protected apply(model: Model, real: Real): Kind[] {
    const id = model.nextId++
    if (model.open.length > 0) tally.overlappingPushes++
    real.handles.set(id, real.ledger.pushStarted())
    model.log.push({ event: 'start', id })
    model.open.push(id)
    model.everStarted = true
    return []
  }
}

abstract class SettlePush extends Step {
  constructor(protected readonly pick: number) {
    super()
  }
  check(model: Readonly<Model>): boolean {
    return model.open.length > 0
  }
  /** Takes the chosen push out of both sides and returns its start index in the log. */
  protected take(model: Model, real: Real): { handle: Handle; startedAt: number } {
    const id = model.open[this.pick % model.open.length]
    model.open = model.open.filter((open) => open !== id)
    const handle = real.handles.get(id)
    if (handle === undefined) throw new Error('model and ledger disagree on which pushes are open')
    real.handles.delete(id)
    return {
      handle,
      startedAt: model.log.findIndex((entry) => entry.event === 'start' && entry.id === id),
    }
  }
  toString(): string {
    return `${this.label}(${this.pick})`
  }
}

class ResolvePush extends SettlePush {
  readonly label = 'resolved'
  protected readonly settles = true
  protected apply(model: Model, real: Real): Kind[] {
    const { handle, startedAt } = this.take(model, real)
    const outstandingBefore = failureOutstanding(model.log)
    handle.resolved()
    model.log.push({ event: 'resolve', startedAt })
    const outstandingAfter = failureOutstanding(model.log)
    if (outstandingBefore && outstandingAfter) tally.epochRuleHeld++
    if (outstandingBefore && !outstandingAfter) tally.recoveredByCleanPush++
    return []
  }
}

class RejectPush extends SettlePush {
  readonly label = 'rejected'
  protected apply(model: Model, real: Real): Kind[] {
    const { handle } = this.take(model, real)
    handle.rejected()
    return failed(model)
  }
}

class DropPush extends SettlePush {
  readonly label = 'dropped'
  protected apply(model: Model, real: Real): Kind[] {
    this.take(model, real).handle.dropped()
    tally.droppedPushes++
    return []
  }
}

/** A failure arrived: always unsaved afterwards, and always said. */
function failed(model: Model): Kind[] {
  if (!model.dirty && model.everStarted) {
    tally.failuresAfterSaved++
    model.reopened = true
  }
  model.log.push({ event: 'failure' })
  model.dirty = true
  return ['degraded']
}

class StorageFailed extends Step {
  readonly label = 'storageFailed'
  protected apply(model: Model, real: Real): Kind[] {
    real.ledger.storageFailed()
    // Before any write or edit this is a failed LOAD, which has its own screen.
    if (!model.everStarted && !model.dirty) {
      tally.silentStorageFailures++
      return []
    }
    return failed(model)
  }
}

class Landed extends Step {
  readonly label = 'landed'
  protected readonly settles = true
  protected apply(model: Model, real: Real): Kind[] {
    const outstanding = failureOutstanding(model.log)
    real.ledger.landed()
    model.log.push({ event: 'landed' })
    if (outstanding) tally.recoveredByLanding++
    return []
  }
}

class Settle extends Step {
  readonly label = 'settle'
  protected readonly settles = true
  protected apply(_model: Model, real: Real): Kind[] {
    real.ledger.settle()
    return []
  }
}

class ToggleBusy extends Step {
  readonly label = 'busy toggled'
  protected apply(model: Model, real: Real): Kind[] {
    real.busy = !real.busy
    model.busy = real.busy
    return []
  }
}

const steps = fc.commands(
  [
    ...Array<fc.Arbitrary<Step>>(3).fill(fc.constant(new Edit())),
    ...Array<fc.Arbitrary<Step>>(3).fill(fc.constant(new StartPush())),
    ...Array<fc.Arbitrary<Step>>(4).fill(fc.nat(3).map((pick) => new ResolvePush(pick))),
    fc.nat(3).map((pick) => new RejectPush(pick)),
    fc.nat(3).map((pick) => new DropPush(pick)),
    fc.constant(new StorageFailed()),
    ...Array<fc.Arbitrary<Step>>(2).fill(fc.constant(new Landed())),
    ...Array<fc.Arbitrary<Step>>(2).fill(fc.constant(new Settle())),
    fc.constant(new ToggleBusy()),
  ],
  { maxCommands: 40, size: 'max' },
)

describe('PersistenceLedger as a state machine', () => {
  beforeAll(() => {
    tally = emptyTally()
  })

  fcTest.prop([steps], withDefaults())(
    'reports what the event log says, and never saved while anything is unsettled',
    (commands) => {
      fc.modelRun(newSession, commands)
    },
  )

  // Floors are statements about the run the property just did: a generator
  // that never reaches the epoch rule or a failure after a settled save would
  // pass every example above without exercising either. Counted as effects (a
  // resolve that was held, not a resolve attempted).
  afterAllFloor(
    ['reports what the event log says, and never saved while anything is unsettled'],
    () => {
      const census = JSON.stringify(tally)
      for (const [name, count] of Object.entries(tally)) {
        expect(count, `${name} never happened\ncensus: ${census}`).toBeGreaterThan(0)
      }
    },
  )

  // Registered after the floor so the census prints first: afterAll hooks run
  // in reverse, and a failing floor stops the ones after it.
  afterAll(() => {
    process.stdout.write(
      `[persistence-ledger census] ${Object.entries(tally)
        .map(([name, count]) => `${name}=${count}`)
        .join(' ')}\n`,
    )
  })
})
