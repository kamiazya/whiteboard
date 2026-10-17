/**
 * Server mode's data dir is named by the operator, and a platform may hand
 * the process one it does not own: a Kubernetes volume is root-owned and
 * shared through `fsGroup`. So `secureDataDir(dir, 'operator')` refuses only a
 * dir every user can write, and leaves the mode the operator chose — the
 * owner-only tightening is for the single-user roots.
 */
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { secureDataDir } from './data-dir-secure.js'
import { CHMOD_IS_OBSERVABLE } from './test-utils/chmod-is-observable.js'

describe.skipIf(!CHMOD_IS_OBSERVABLE)('secureDataDir for an operator-named dir', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wb-data-dir-operator-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps a group-shared mode as the operator set it', () => {
    chmodSync(dir, 0o2775)
    secureDataDir(dir, 'operator')
    expect(statSync(dir).mode & 0o7777).toBe(0o2775)
  })

  it('refuses a dir every user can write', () => {
    chmodSync(dir, 0o777)
    expect(statSync(dir).mode & 0o777).toBe(0o777)
    expect(() => secureDataDir(dir, 'operator')).toThrow(/writable by every user/)
  })

  it('tightens the same dir to owner-only for a single-user root', () => {
    chmodSync(dir, 0o2775)
    secureDataDir(dir)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
  })
})
