// A named lease, so one instance of a multi-instance deployment does a piece
// of discardable work and the others stand down.
//
// ADR-0020 is explicit that this mechanism is RENTED, "never a bespoke
// implementation" — and what is rented here is the database's own atomic
// conditional update, in the store every instance already shares. A
// deployment that has answered "where do the rows live" has already answered
// "where does the lease live", which is why this needs no new dependency, no
// new port, and no new thing for an operator to run.
//
// It is deliberately NOT a general coordination primitive. It is safe only
// for work that is expensive and DISCARDABLE: a backup pass, a retention
// sweep. Two instances briefly believing they are the leader — possible if
// one stalls past its own expiry while its clock says otherwise — costs a
// duplicate backup, which is exactly the loss the lease exists to reduce and
// not a correctness failure. Anything that must happen exactly once still
// needs the fencing token ADR-0020 describes.

import { getLogger } from '../log.js'
import type { Database } from './db/index.js'

const log = getLogger('lease')

export interface LeaseRequest {
  /** The lease's subject, e.g. `backup`. Separate names never contend. */
  name: string
  /** This instance. The daemon's `instanceId`, minted once per process. */
  holder: string
  /** How long a grant is good for without renewal. */
  ttlMs: number
  nowMs: number
}

/**
 * Take the lease, or extend it if this holder already has it.
 *
 * One statement, so the check and the write cannot be separated by another
 * instance. `ON CONFLICT ... DO UPDATE ... WHERE` applies only when the row is
 * expired or already ours; when it does not apply, no row comes back and this
 * answers `false`. A read-then-write version of the same logic hands the lease
 * to every instance that reads before any of them writes.
 *
 * Measured across process boundaries rather than argued, since an in-process
 * test cannot tell an atomic statement from one the event loop happened to
 * serialise: six separate Node processes, one shared `file:` database, all
 * released on a wall-clock barrier, seven rounds — exactly one GRANTED every
 * round. The losers split between a clean refusal and `SQLITE_BUSY`, which
 * the caller treats as "cannot establish leadership" and stands down on, so
 * both readings are safe. A shared file is not a supported multi-instance
 * arrangement anyway (ADR-0020 sends those to a libSQL server, whose own
 * serialisation removes the BUSY half); it is simply the harshest thing
 * available to test the statement against.
 */
export async function acquireLease(db: Database, request: LeaseRequest): Promise<boolean> {
  const { name, holder, ttlMs, nowMs } = request
  const rows = await db
    .insertInto('leases')
    .values({ name, holder, expiresAt: nowMs + ttlMs })
    .onConflict((oc) =>
      oc
        .column('name')
        .doUpdateSet({ holder, expiresAt: nowMs + ttlMs })
        .where((eb) =>
          eb.or([eb('leases.expiresAt', '<=', nowMs), eb('leases.holder', '=', holder)]),
        ),
    )
    .returning('holder')
    .execute()
  return rows.length > 0
}

/**
 * Give the lease back, so the next scheduled run is not skipped by everyone
 * waiting out a TTL for work that has already finished.
 *
 * Scoped to the holder: an instance that stalled past its own expiry and lost
 * the lease must not delete the row the new holder wrote on its way out.
 */
export async function releaseLease(
  db: Database,
  request: Pick<LeaseRequest, 'name' | 'holder'>,
): Promise<void> {
  await db
    .deleteFrom('leases')
    .where('name', '=', request.name)
    .where('holder', '=', request.holder)
    .execute()
}

export interface WithLeaseOptions {
  name: string
  holder: string
  ttlMs: number
  /**
   * How often to renew while the body runs. Defaults to a third of the TTL,
   * so two renewals can be lost before the lease does.
   */
  renewEveryMs?: number
  nowMs?: () => number
}

export type LeaseOutcome<T> = { ok: true; value: T } | { ok: false; reason: 'not-leader' }

/**
 * Run `body` iff this instance is the leader for `name`.
 *
 * The lease is renewed for as long as the body runs, because how long a pass
 * takes is a property of the data rather than of any constant chosen here — a
 * backup copies every blob. Without renewal a slow pass loses the lease
 * mid-flight and a second instance starts a second pass over the top of it,
 * which is the case this exists to prevent.
 */
export async function withLease<T>(
  db: Database,
  options: WithLeaseOptions,
  body: () => Promise<T>,
): Promise<LeaseOutcome<T>> {
  const { name, holder, ttlMs } = options
  const nowMs = options.nowMs ?? (() => Date.now())
  const renewEveryMs = options.renewEveryMs ?? Math.max(1_000, Math.floor(ttlMs / 3))

  if (!(await acquireLease(db, { name, holder, ttlMs, nowMs: nowMs() }))) {
    return { ok: false, reason: 'not-leader' }
  }

  // unref'd: a renewal timer must never be the reason an otherwise idle
  // process stays alive, the same rule the schedulers themselves follow.
  const renew = setInterval(() => {
    void acquireLease(db, { name, holder, ttlMs, nowMs: nowMs() })
      .then((held) => {
        if (!held) {
          // Only reachable if this process stalled past its own expiry and
          // another instance took over. Said out loud: from here on there may
          // be two passes running, and this is the only place that knows.
          log.error({ lease: name, holder }, 'lost the lease while the work was still running')
        }
      })
      .catch((err) => {
        log.warning({ lease: name, holder, err }, 'could not renew the lease')
      })
  }, renewEveryMs)
  renew.unref()

  try {
    return { ok: true, value: await body() }
  } finally {
    clearInterval(renew)
    // A body that threw still gives the lease back: holding it until expiry
    // after a failed pass means the next run is skipped by whichever instance
    // is healthy.
    await releaseLease(db, { name, holder }).catch((err) => {
      log.warning({ lease: name, holder, err }, 'could not release the lease')
    })
  }
}
