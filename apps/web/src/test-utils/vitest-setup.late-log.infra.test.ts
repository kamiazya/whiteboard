/**
 * The shared setup waits for a file's late logging before its environment
 * closes. This file IS the case: every test leaves timers that log after it
 * ends. What fails without the wait is not a test but the file, which exits 1
 * on `Closing rpc while "onUserConsoleLog" was pending` with every test
 * passed — so this file is its own regression check, one of its own.
 *
 * Probabilistic by nature. Measured with the wait removed: this shape failed
 * 10 of 20 runs; with it, 0 of 20. A single run can miss a regression, and
 * CI's stress lane runs a changed file five times.
 */
import { expect, it } from 'vitest'

for (let n = 0; n < 10; n++) {
  it(`closes cleanly after work that logs once the test has ended (${n})`, () => {
    for (let i = 0; i < 20; i++) setTimeout(() => console.log('late log', n, i), i * 2)
    expect(n).toBeGreaterThanOrEqual(0)
  })
}
