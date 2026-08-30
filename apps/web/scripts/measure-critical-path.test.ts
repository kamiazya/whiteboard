import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseFloorMs } from './measure-critical-path.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'measure-critical-path.mjs')

describe('parseFloorMs', () => {
  it('reports no floor when the variable is absent or empty — the instrument mode this script was built as', () => {
    expect(parseFloorMs(undefined)).toEqual({ floor: null })
    expect(parseFloorMs('')).toEqual({ floor: null })
  })

  it('accepts a positive number of milliseconds', () => {
    expect(parseFloorMs('1000')).toEqual({ floor: 1000 })
    expect(parseFloorMs('492.5')).toEqual({ floor: 492.5 })
  })

  // Each of these would otherwise ARM the gate and pass every run, because
  // `NaN === null` is false and `median > NaN` is false. Measured on the
  // unfixed script: `LCP floor: OK — median 496ms, floor NaNms`, exit 0.
  it.each([
    'abc',
    '1000ms',
    'NaN',
    '0',
    '-5',
    'Infinity',
  ])('refuses %j rather than silently disabling the gate', (raw) => {
    const result = parseFloorMs(raw)
    expect(result.floor).toBeUndefined()
    expect(result.error).toContain('LCP_FLOOR_MS must be a positive number')
    expect(result.error).toContain(JSON.stringify(raw))
  })
})

describe('the gate script itself', () => {
  // Two things at once, and the second is why this is a subprocess rather
  // than another call to `parseFloorMs`:
  //
  // 1. the refusal is WIRED — a bad floor exits non-zero, so CI goes red;
  // 2. `main()` runs at all when the file is executed directly. It sits
  //    behind an `import.meta.url === file://${process.argv[1]}` guard so
  //    this test can import the module; break that expression and the CI
  //    step measures nothing and exits 0 — a green job over a gate that no
  //    longer exists. Then nothing is printed here and the exit code is 0,
  //    which is what this case refuses.
  //
  // Asserting the MESSAGE is load-bearing, not decoration: a missing
  // `dist/` also exits 1, so an exit-code-only assertion would pass on a
  // machine that never reached the subject.
  it('exits non-zero and names the variable when the floor is unparseable', () => {
    let status: number | null = null
    let stderr = ''
    try {
      execFileSync(process.execPath, [SCRIPT], {
        env: { ...process.env, LCP_FLOOR_MS: 'abc' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      const e = err as { status?: number; stderr?: string }
      status = e.status ?? null
      stderr = e.stderr ?? ''
    }
    expect(status).toBe(1)
    expect(stderr).toContain('LCP_FLOOR_MS must be a positive number')
  })
})
