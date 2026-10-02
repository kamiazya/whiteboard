/**
 * Both sides of the skip this probe gates, because a skipped test reads
 * exactly like a passing one in the summary line: the owner-only-mode guards
 * on the daemon token, the macaroon root key and the identity key stop
 * running everywhere if it answers `false`, and nothing goes red.
 */
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHMOD_IS_OBSERVABLE, probeChmodIsObservable } from './chmod-is-observable.js'

describe('CHMOD_IS_OBSERVABLE', () => {
  it('agrees with whether a mode set here is a mode read back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-chmod-check-'))
    try {
      const file = join(dir, 'f')
      writeFileSync(file, 'x')
      chmodSync(file, 0o600)
      const observed = (statSync(file).mode & 0o777) === 0o600
      expect(
        observed,
        'the probe and a fresh chmod-and-stat disagree, so every skip it gates is decided on a stale answer',
      ).toBe(CHMOD_IS_OBSERVABLE)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The half that stops the skip becoming permanent: CI is the run whose
  // green is load-bearing, so the owner-only-mode paths must run for real there.
  it.runIf(process.env.CI)(
    'is true on CI, where the owner-only mode guards must run for real',
    () => {
      expect(
        CHMOD_IS_OBSERVABLE,
        'CI can no longer observe a file mode, so the secret-file mode tests are being skipped there — find out why before trusting this run',
      ).toBe(true)
    },
  )
})

describe('probeChmodIsObservable', () => {
  it('answers true for a chmod that sticks', () => {
    expect(probeChmodIsObservable((path, mode) => chmodSync(path, mode))).toBe(true)
  })

  it('answers false for a chmod that succeeds and leaves the mode unchanged', () => {
    expect(probeChmodIsObservable(() => undefined)).toBe(false)
  })

  it('throws when chmod errors, rather than answering that modes are unobservable', () => {
    const failing = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    }
    expect(() => probeChmodIsObservable(failing)).toThrow(/EPERM/)
  })
})
