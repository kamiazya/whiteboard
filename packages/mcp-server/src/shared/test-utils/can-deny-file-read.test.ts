/**
 * Both sides of the skip this probe gates, because a skipped test reads
 * exactly like a passing one in the summary line.
 *
 * A capability probe is the honest way to skip a test whose PREMISE cannot be
 * established here — but it is also the easy way to lose coverage for good:
 * flip the probe to `false` and three EACCES tests quietly stop running
 * everywhere, and nothing goes red. So the probe is checked for honesty, and
 * CI is required to have the capability.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAN_DENY_FILE_READ } from './can-deny-file-read.js'

describe('CAN_DENY_FILE_READ', () => {
  it('agrees with what a mode-000 file actually does here', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-deny-check-'))
    const file = join(dir, 'closed-off')
    try {
      writeFileSync(file, 'x')
      chmodSync(file, 0o000)
      let denied: boolean
      try {
        readFileSync(file)
        denied = false
      } catch {
        denied = true
      }
      expect(
        denied,
        'the probe and a fresh mode-000 read disagree, so every skip it gates is decided on a stale answer',
      ).toBe(CAN_DENY_FILE_READ)
    } finally {
      try {
        chmodSync(file, 0o644)
      } catch {
        // Already gone; the rm is what matters.
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The half that stops the skip becoming permanent. CI is the run whose
  // green is load-bearing, so the EACCES paths must be genuinely exercised
  // there — a probe that answered `false` on the runner would disable them
  // for everyone while every summary line stayed green.
  it.runIf(process.env.CI)('is true on CI, where these paths must run for real', () => {
    expect(
      CAN_DENY_FILE_READ,
      'CI can no longer make a file unreadable, so every EACCES test is being skipped there — find out why before trusting this run',
    ).toBe(true)
  })
})
