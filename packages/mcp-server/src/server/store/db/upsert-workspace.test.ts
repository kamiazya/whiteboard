import { WorkspaceSegmentTakenError } from '@kamiazya/whiteboard-ports'
import { describe, expect, it } from 'vitest'
import type { Database } from './index.js'
import { renameWorkspaceRow, upsertWorkspaceRow } from './upsert-workspace.js'

/**
 * How a segment collision is RECOGNISED, as opposed to what happens once it
 * is — `workspaces.test.ts` and `mint-daemon.test.ts` already drive the real
 * driver end to end and assert the 409 the route promises.
 *
 * That coverage has a blind spot this file exists to fill, and it is the
 * blind spot that produced the bug: the driver reports the violation under
 * one of TWO shapes, only one of which the installed driver can raise.
 * libsql 0.3.19 put `SQLITE_CONSTRAINT_UNIQUE` in `code`; 0.5.29 puts
 * `SQLITE_CONSTRAINT` there and moves the detail to `extendedCode`.
 * `one-libsql-stack.test.ts` now pins the tree to exactly one of them, so
 * every end-to-end test raises the 0.5.29 shape and NOTHING exercises the
 * other arm. Measured: deleting the `code` arm leaves all 54 of those tests
 * passing, while deleting the `extendedCode` arm fails two — so half the
 * predicate read as covered while being dead.
 *
 * Both arms are kept rather than the dead one deleted, because the shape
 * moving is not hypothetical: it moved once, silently, and turned the 409
 * into a 500. A synthetic error is the only instrument that can reach the
 * arm the pinned driver cannot raise.
 */

/** A `Database` whose every builder chain ends in `err`. */
function throwingDb(err: unknown): Database {
  const chain: unknown = new Proxy(() => undefined, {
    get: (_target, prop) =>
      prop === 'execute' || prop === 'executeTakeFirst' ? () => Promise.reject(err) : chain,
    apply: () => chain,
  })
  return chain as Database
}

/** What the driver raises: an Error carrying the driver's own fields. */
function driverError(fields: { code?: string; extendedCode?: string }, message: string): Error {
  return Object.assign(new Error(message), fields)
}

const SEGMENT_MESSAGE = 'SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: workspaces.segment'

const SHAPES = {
  'libsql 0.5.29 — the detail in extendedCode': driverError(
    { code: 'SQLITE_CONSTRAINT', extendedCode: 'SQLITE_CONSTRAINT_UNIQUE' },
    SEGMENT_MESSAGE,
  ),
  'libsql 0.3.19 — the detail in code': driverError(
    { code: 'SQLITE_CONSTRAINT_UNIQUE' },
    SEGMENT_MESSAGE,
  ),
} as const

describe('a segment collision, in either shape the driver reports it', () => {
  for (const [shape, err] of Object.entries(SHAPES)) {
    it(`upsert names the taken segment — ${shape}`, async () => {
      await expect(
        upsertWorkspaceRow(throwingDb(err), 'w1', { segment: 'taken' }),
      ).rejects.toBeInstanceOf(WorkspaceSegmentTakenError)
    })

    it(`rename names the taken segment — ${shape}`, async () => {
      await expect(
        renameWorkspaceRow(throwingDb(err), 'w1', { segment: 'taken' }),
      ).rejects.toBeInstanceOf(WorkspaceSegmentTakenError)
    })
  }

  it('carries the segment that was refused, not the workspace', async () => {
    const caught = await upsertWorkspaceRow(
      throwingDb(SHAPES['libsql 0.5.29 — the detail in extendedCode']),
      'w1',
      {
        segment: 'taken',
      },
    ).catch((err: unknown) => err)
    expect(caught).toBeInstanceOf(WorkspaceSegmentTakenError)
    expect((caught as WorkspaceSegmentTakenError).segment).toBe('taken')
  })
})

describe('what is NOT a segment collision', () => {
  it('rethrows a unique violation on another column', async () => {
    // The predicate reads the message as well as the code, because `id` has
    // its own unique constraint and `onConflict('id')` does not cover a
    // write that reaches this path some other way.
    const err = driverError(
      { code: 'SQLITE_CONSTRAINT', extendedCode: 'SQLITE_CONSTRAINT_UNIQUE' },
      'SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: workspaces.id',
    )
    await expect(upsertWorkspaceRow(throwingDb(err), 'w1', { segment: 'free' })).rejects.toBe(err)
  })

  it('rethrows when the write claimed no segment at all', async () => {
    // A collision on a segment this call never asked for is somebody else's
    // to report — there is no segment to name in the error.
    await expect(
      upsertWorkspaceRow(throwingDb(SHAPES['libsql 0.3.19 — the detail in code']), 'w1', {}),
    ).rejects.toBe(SHAPES['libsql 0.3.19 — the detail in code'])
  })

  it('rethrows a failure that is not a constraint violation', async () => {
    const err = driverError({ code: 'SQLITE_BUSY' }, 'database is locked')
    await expect(upsertWorkspaceRow(throwingDb(err), 'w1', { segment: 'free' })).rejects.toBe(err)
  })

  it('rethrows a non-Error rejection untouched', async () => {
    await expect(
      upsertWorkspaceRow(throwingDb('not an error'), 'w1', { segment: 'x' }),
    ).rejects.toBe('not an error')
  })
})
