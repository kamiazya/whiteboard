/**
 * Which directory modes the data-dir check refuses. World-writable lets anyone
 * replace daemon.json, so it is refused; group-writable is accepted on
 * purpose, because under user-private groups (umask 002) that group is this
 * user and refusing it would lock out everyone who runs with that umask.
 * Only the other-write bit separates the two, and a check that tested the
 * group bit instead would pass the world-writable test and fail these.
 */
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertDataDirOwnedByUser } from './data-dir-secure.js'
import { CHMOD_IS_OBSERVABLE } from './test-utils/chmod-is-observable.js'

describe.skipIf(!CHMOD_IS_OBSERVABLE)('assertDataDirOwnedByUser modes', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-data-dir-modes-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** The directory at `mode`, read back so the case is known to have reached it. */
  function check(mode: number): void {
    chmodSync(dir, mode)
    expect(statSync(dir).mode & 0o777).toBe(mode)
    assertDataDirOwnedByUser(dir, statSync(dir).uid)
  }

  it.each([
    ['0o700', 0o700],
    ['0o770', 0o770],
    ['0o775', 0o775],
  ])('accepts mode %s, which no other user can write', (_label, mode) => {
    expect(() => check(mode)).not.toThrow()
  })

  it.each([
    ['0o707', 0o707],
    ['0o757', 0o757],
    ['0o777', 0o777],
    ['0o702', 0o702],
  ])('refuses mode %s, which other users can write', (_label, mode) => {
    expect(() => check(mode)).toThrow(/writable by other users/)
  })
})
