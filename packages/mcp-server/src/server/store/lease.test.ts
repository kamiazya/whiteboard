import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIsolatedDb } from './db/test-helpers.js'
import { acquireLease, releaseLease, withLease } from './lease.js'

let root: string
let handle: Awaited<ReturnType<typeof createIsolatedDb>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-lease-'))
  handle = await createIsolatedDb({ dataDir: root })
})
afterEach(async () => {
  vi.useRealTimers()
  await handle.dispose()
  await rm(root, { recursive: true, force: true })
})

const T0 = 1_800_000_000_000

/**
 * ADR-0020: the mechanism is RENTED, never written here. A lease row in the
 * database every instance already shares is the cheapest thing that is
 * actually shared — the same store the rows themselves live in, so a
 * deployment that has solved "where do the rows live" has already solved
 * "where does the lease live".
 *
 * What it buys: work that is discardable but expensive — a backup pass, and
 * its retention — happens once per deployment rather than once per instance.
 * Two instances backing up the same data directory is not merely wasteful:
 * their retention passes each delete from a set the other is changing.
 */
describe('the leader lease', () => {
  it('admits one holder and refuses the other', async () => {
    const first = await acquireLease(handle.db, {
      name: 'backup',
      holder: 'instance-a',
      ttlMs: 60_000,
      nowMs: T0,
    })
    const second = await acquireLease(handle.db, {
      name: 'backup',
      holder: 'instance-b',
      ttlMs: 60_000,
      nowMs: T0,
    })

    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  /**
   * Concurrently, not one after the other. Sequential calls would pass
   * against a read-then-write implementation that has no atomicity at all,
   * which is the whole thing this has to get right.
   */
  it('admits exactly one of a simultaneous pair', async () => {
    const attempts = ['a', 'b', 'c', 'd', 'e'].map((holder) =>
      acquireLease(handle.db, { name: 'backup', holder, ttlMs: 60_000, nowMs: T0 }),
    )
    const granted = (await Promise.all(attempts)).filter(Boolean)
    expect(granted).toHaveLength(1)
  })

  /**
   * An instance that dies holding the lease must not stop the deployment
   * backing up forever. Expiry is the recovery, and it is time-based rather
   * than liveness-based on purpose: a pid means nothing to another container,
   * which is exactly why the in-progress marker beside it cannot do this job.
   */
  it('hands over once the holder has stopped renewing', async () => {
    expect(
      await acquireLease(handle.db, {
        name: 'backup',
        holder: 'gone',
        ttlMs: 60_000,
        nowMs: T0,
      }),
    ).toBe(true)
    expect(
      await acquireLease(handle.db, {
        name: 'backup',
        holder: 'next',
        ttlMs: 60_000,
        nowMs: T0 + 59_999,
      }),
    ).toBe(false)
    expect(
      await acquireLease(handle.db, {
        name: 'backup',
        holder: 'next',
        ttlMs: 60_000,
        nowMs: T0 + 60_001,
      }),
    ).toBe(true)
  })

  /** Renewal is the same statement: the holder is always allowed to extend. */
  it('lets the holder push its own expiry out', async () => {
    await acquireLease(handle.db, { name: 'backup', holder: 'a', ttlMs: 60_000, nowMs: T0 })
    expect(
      await acquireLease(handle.db, {
        name: 'backup',
        holder: 'a',
        ttlMs: 60_000,
        nowMs: T0 + 30_000,
      }),
    ).toBe(true)
    // The renewal moved expiry to T0+90_000, so the moment the original lease
    // would have lapsed is no longer an opening.
    expect(
      await acquireLease(handle.db, {
        name: 'backup',
        holder: 'b',
        ttlMs: 60_000,
        nowMs: T0 + 60_001,
      }),
    ).toBe(false)
  })

  it('frees the lease when the holder releases it', async () => {
    await acquireLease(handle.db, { name: 'backup', holder: 'a', ttlMs: 60_000, nowMs: T0 })
    await releaseLease(handle.db, { name: 'backup', holder: 'a' })
    expect(
      await acquireLease(handle.db, {
        name: 'backup',
        holder: 'b',
        ttlMs: 60_000,
        nowMs: T0 + 1,
      }),
    ).toBe(true)
  })

  /**
   * Releasing is scoped to the holder, so an instance that lost the lease
   * (stalled past its own expiry, someone else took over) cannot delete the
   * new holder's row on its way out — which would hand a third instance a
   * lease the second one thinks it holds.
   */
  it('ignores a release from an instance that no longer holds it', async () => {
    await acquireLease(handle.db, { name: 'backup', holder: 'stalled', ttlMs: 1, nowMs: T0 })
    await acquireLease(handle.db, {
      name: 'backup',
      holder: 'current',
      ttlMs: 60_000,
      nowMs: T0 + 2,
    })
    await releaseLease(handle.db, { name: 'backup', holder: 'stalled' })
    expect(
      await acquireLease(handle.db, {
        name: 'backup',
        holder: 'third',
        ttlMs: 60_000,
        nowMs: T0 + 3,
      }),
    ).toBe(false)
  })

  /** Different names are different leases; one leader does not block another. */
  it('keeps separate names separate', async () => {
    await acquireLease(handle.db, { name: 'backup', holder: 'a', ttlMs: 60_000, nowMs: T0 })
    expect(
      await acquireLease(handle.db, { name: 'other', holder: 'b', ttlMs: 60_000, nowMs: T0 }),
    ).toBe(true)
  })

  describe('withLease', () => {
    it('runs the body once and releases afterwards', async () => {
      let ran = 0
      const result = await withLease(
        handle.db,
        { name: 'backup', holder: 'a', ttlMs: 60_000, nowMs: () => T0 },
        async () => {
          ran += 1
          return 'done' as const
        },
      )
      expect(result).toEqual({ ok: true, value: 'done' })
      expect(ran).toBe(1)
      // Released, so the next instance to come along takes it immediately
      // rather than waiting out a TTL for work that has already finished.
      expect(
        await acquireLease(handle.db, {
          name: 'backup',
          holder: 'b',
          ttlMs: 60_000,
          nowMs: T0 + 1,
        }),
      ).toBe(true)
    })

    it('does not run the body when another instance holds the lease', async () => {
      await acquireLease(handle.db, { name: 'backup', holder: 'a', ttlMs: 60_000, nowMs: T0 })
      let ran = 0
      const result = await withLease(
        handle.db,
        { name: 'backup', holder: 'b', ttlMs: 60_000, nowMs: () => T0 },
        async () => {
          ran += 1
        },
      )
      expect(result).toEqual({ ok: false, reason: 'not-leader' })
      expect(ran).toBe(0)
    })

    /**
     * A body that throws still gives the lease back. Holding it until expiry
     * after a failed pass would mean the next scheduled run is skipped by
     * whichever instance is healthy, which is the opposite of what a leader
     * lease is for.
     */
    it('releases the lease when the body throws', async () => {
      await expect(
        withLease(
          handle.db,
          { name: 'backup', holder: 'a', ttlMs: 60_000, nowMs: () => T0 },
          async () => {
            throw new Error('pass failed')
          },
        ),
      ).rejects.toThrow('pass failed')
      expect(
        await acquireLease(handle.db, {
          name: 'backup',
          holder: 'b',
          ttlMs: 60_000,
          nowMs: T0 + 1,
        }),
      ).toBe(true)
    })

    /**
     * A pass can outlast its own TTL — a backup copies every blob, and how
     * long that takes is a property of the data, not of any constant chosen
     * here. So the lease is renewed while the body runs; without that, a slow
     * pass loses the lease mid-flight and a second instance starts a second
     * backup over the top of it.
     */
    it('renews while the body is still running', async () => {
      let clock = T0
      let released: boolean | null = null
      await withLease(
        handle.db,
        { name: 'backup', holder: 'a', ttlMs: 60_000, renewEveryMs: 10, nowMs: () => clock },
        async () => {
          // Well past the original expiry.
          clock = T0 + 500_000
          await new Promise((r) => setTimeout(r, 60))
          released = await acquireLease(handle.db, {
            name: 'backup',
            holder: 'b',
            ttlMs: 60_000,
            nowMs: clock,
          })
        },
      )
      expect(released).toBe(false)
    })
  })

  /**
   * Production never passes `renewEveryMs` (the backup scheduler gives only a
   * TTL), so the derived cadence is what keeps a long pass the leader. Only the
   * interval is faked, and the renewal is observed in the lease row itself, so
   * it is the cadence that is measured and not a real wait.
   */
  describe('with the renewal cadence left to its default', () => {
    const expiryOf = async (): Promise<number | undefined> =>
      (
        await handle.db
          .selectFrom('leases')
          .select('expiresAt')
          .where('name', '=', 'backup')
          .executeTakeFirst()
      )?.expiresAt

    // A third of the TTL, floored at a second: two renewals can be lost before
    // the lease is.
    it.each([
      { ttlMs: 60_000, cadenceMs: 20_000 },
      { ttlMs: 1_500, cadenceMs: 1_000 },
    ])('renews every $cadenceMs ms for a $ttlMs ms ttl, and not before', async ({
      ttlMs,
      cadenceMs,
    }) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      let clock = T0
      let beforeCadence: number | undefined
      let atCadence: number | undefined
      await withLease(
        handle.db,
        { name: 'backup', holder: 'a', ttlMs, nowMs: () => clock },
        async () => {
          // Moved off the grant, so a renewal is distinguishable from it.
          clock = T0 + 100
          await vi.advanceTimersByTimeAsync(cadenceMs - 1)
          beforeCadence = await expiryOf()
          await vi.advanceTimersByTimeAsync(1)
          // Bounded by an attempt count: the renewal is an async write, and a
          // cadence that never fires must fall through to the assertion.
          for (let attempt = 0; attempt < 2_000; attempt += 1) {
            atCadence = await expiryOf()
            if (atCadence !== T0 + ttlMs) break
          }
        },
      )
      expect(beforeCadence).toBe(T0 + ttlMs)
      expect(atCadence).toBe(T0 + 100 + ttlMs)
    })
  })

  /**
   * An interval left running after the body ends would re-acquire the lease it
   * has just given back, so the finished holder stays the leader and starves
   * every other instance until the process exits.
   */
  it('stops renewing once the body has ended', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let during = 0
    await withLease(handle.db, { name: 'backup', holder: 'a', ttlMs: 60_000 }, async () => {
      during = vi.getTimerCount()
    })
    expect(during).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops renewing when the body throws', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await expect(
      withLease(handle.db, { name: 'backup', holder: 'a', ttlMs: 60_000 }, async () => {
        throw new Error('pass failed')
      }),
    ).rejects.toThrow('pass failed')
    expect(vi.getTimerCount()).toBe(0)
  })
})
