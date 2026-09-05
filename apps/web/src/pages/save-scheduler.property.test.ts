// @vitest-environment node
/**
 * The save scheduler, under every interleaving of typing, timers, leaving,
 * and writes landing.
 *
 * This exists because the same 500ms debounce produced two defects in two
 * consecutive PRs, and neither reproduced on an idle machine: both needed a
 * timer to fire PART-WAY through typing. An example test has to guess that
 * arrangement; a model generates it.
 *
 * Time is a command here rather than a clock. `tick` fires whatever timer is
 * armed, `settle` lands whatever write is in flight, and the generator is
 * free to put an edit between them — which is precisely the window both
 * defects lived in.
 */
import { afterAll, describe, expect, it } from 'vitest'
import type { BrowserPersistenceState } from '../lib/browser-persistence-state.js'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { createSaveScheduler, type SaveTimer } from './save-scheduler.js'

/** A fake host: one armed timer, one in-flight write, and what has landed. */
class Harness {
  state: BrowserPersistenceState = { kind: 'saved', lastSavedAt: null }
  /** The edit number the document currently holds. */
  current = 0
  /** The edit number the last landed write persisted. */
  persisted = 0
  /** How many writes have landed, for the vacuity guard. */
  landed = 0

  #armed: (() => void) | null = null
  #inFlight: { resolve: () => void; reject: () => void } | null = null
  #queue: Promise<unknown> = Promise.resolve()
  #capturedBySave = 0

  readonly scheduler = createSaveScheduler({
    debounceMs: 500,
    now: () => new Date(1e12 + this.landed).toISOString(),
    report: (update) => {
      this.state = typeof update === 'function' ? update(this.state) : update
    },
    beginSave: () => () => {
      // A write persists what the document holds AT THE MOMENT IT STARTS —
      // an edit arriving later is not in it. That is the whole subject.
      this.#capturedBySave = this.current
      return new Promise<void>((resolve, reject) => {
        this.#inFlight = {
          resolve: () => {
            this.persisted = this.#capturedBySave
            this.landed += 1
            resolve()
          },
          reject: () => reject(new Error('write failed')),
        }
      })
    },
    enqueue: (save) => {
      this.#queue = this.#queue.then(() => save()).catch(() => {})
    },
    setTimer: (fire) => {
      this.#armed = fire
      return fire as SaveTimer
    },
    clearTimer: () => {
      this.#armed = null
    },
  })

  get timerArmed(): boolean {
    return this.#armed !== null
  }
  get writeInFlight(): boolean {
    return this.#inFlight !== null
  }

  type(): void {
    this.current += 1
    this.scheduler.edit()
  }
  tick(): void {
    const fire = this.#armed
    this.#armed = null
    fire?.()
  }
  leave(): void {
    this.scheduler.flush()
  }
  async settle(outcome: 'ok' | 'fail'): Promise<void> {
    const flight = this.#inFlight
    if (flight === null) return
    this.#inFlight = null
    if (outcome === 'ok') flight.resolve()
    else flight.reject()
  }

  /**
   * Lets whatever the queue has chained actually start. Without this a step
   * boundary is not a moment in time — `enqueue` defers through a promise, so
   * a fired timer has not begun its write yet, and "an edit arrives while a
   * write is in flight" becomes unreachable. The vacuity guard below is what
   * caught that: the counter read 0.
   */
  async drain(): Promise<void> {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  /** Nothing armed and nothing in flight: the document is at rest. */
  get quiescent(): boolean {
    return !this.timerArmed && !this.writeInFlight
  }
}

const stats = { typed: 0, landedWrites: 0, editDuringWrite: 0, quiescentChecks: 0 }

const step = fc.oneof(
  { weight: 4, arbitrary: fc.constant('type' as const) },
  { weight: 3, arbitrary: fc.constant('tick' as const) },
  { weight: 3, arbitrary: fc.constant('settle-ok' as const) },
  { weight: 1, arbitrary: fc.constant('settle-fail' as const) },
  { weight: 1, arbitrary: fc.constant('leave' as const) },
)

describe('save scheduler under interleaved typing and writes', () => {
  /**
   * The shrunk counterexample, pinned before the fix. A write starts, an edit
   * lands while it is in flight, and the write's success reports `saved` —
   * over text that is not in it. The indicator then claims safety for as long
   * as the next debounce takes.
   *
   * This is the root cause of the settle window `waitForMarkdownSaved` had to
   * grow: that wait was compensating for an indicator that could say `saved`
   * about an earlier write.
   */
  it('does not report saved for a write that started before the latest edit', async () => {
    const h = new Harness()
    h.type() //             edit 1, debounce armed
    h.tick() //             timer fires; the write is only ENQUEUED here
    await h.drain() //      the queue starts it, capturing edit 1
    h.type() //             edit 2 lands while that write is still in flight
    await h.settle('ok') // and the write, which does not contain it, succeeds
    await h.drain()

    if (h.state.kind === 'saved') expect(h.persisted).toBe(h.current)
  })

  fcTest.prop([fc.array(step, { minLength: 1, maxLength: 24 })], withDefaults({ numRuns: 300 }))(
    'the indicator never reports `saved` over an edit that is not in the store',
    async (steps) => {
      const h = new Harness()
      for (const s of steps) {
        if (s === 'type') {
          if (h.writeInFlight) stats.editDuringWrite += 1
          stats.typed += 1
          h.type()
        } else if (s === 'tick') h.tick()
        else if (s === 'leave') h.leave()
        else await h.settle(s === 'settle-ok' ? 'ok' : 'fail')
        await h.drain()

        // S1 — the load-bearing one. "Saved" is a claim about the CURRENT
        // text, not about some earlier write having succeeded. Anything
        // weaker is what let a save wait settle on a partial body.
        if (h.state.kind === 'saved' && h.persisted !== h.current) {
          throw new Error(
            `reported "saved" with edit ${h.current} unwritten (store holds ${h.persisted})`,
          )
        }
      }
      stats.landedWrites += h.landed

      // S2 — convergence. Once nothing is armed and nothing is in flight,
      // either the store has the last edit or the indicator says so.
      if (h.quiescent) {
        stats.quiescentChecks += 1
        if (h.persisted !== h.current) expect(h.state.kind).not.toBe('saved')
      }
    },
  )

  afterAll(() => {
    // The arrangement both defects needed is an edit arriving while a write
    // is in flight. A run that never produced one has asserted nothing about
    // the window this file exists for.
    expect(
      stats.editDuringWrite,
      'no run typed while a write was in flight — the generator never reached the window',
    ).toBeGreaterThan(0)
    expect(stats.landedWrites, 'no write ever landed').toBeGreaterThan(0)
    expect(stats.quiescentChecks, 'no run ever came to rest').toBeGreaterThan(0)
  })
})
