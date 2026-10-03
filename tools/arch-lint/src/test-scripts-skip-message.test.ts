// `pnpm test:scripts` skips the ImageMagick-dependent cases when `convert` is
// absent, and CONTRIBUTING.md promises the skip says what to install. A
// reporter that prints one character per test (`dot`) prints the same one for
// a skipped test as for a passing one, so the message the test carries was
// dropped before anyone could read it and a skip read exactly like a pass.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const script: string = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
).scripts['test:scripts']!

describe('pnpm test:scripts says so when it skips', () => {
  it('names ImageMagick in its output when `convert` is not on the PATH', () => {
    const reporter = /--test-reporter=(\S+)/.exec(script)?.[1]
    expect(reporter, 'test:scripts names no --test-reporter').toBeDefined()
    // An empty PATH directory: the test probes `convert` with execFileSync, so
    // the binary is absent here whether or not the machine has it. `CI` is
    // unset because the file refuses to run without the tool there.
    const emptyBin = mkdtempSync(join(tmpdir(), 'no-convert-'))
    try {
      const { CI: _ci, ...env } = process.env
      const run = spawnSync(
        process.execPath,
        ['--test', `--test-reporter=${reporter}`, '.claude/scripts/compose-figure.test.mjs'],
        { cwd: REPO_ROOT, env: { ...env, PATH: emptyBin }, encoding: 'utf8' },
      )
      expect(run.status).toBe(0)
      expect(run.stdout).toMatch(/ImageMagick/)
    } finally {
      rmSync(emptyBin, { recursive: true, force: true })
    }
  })
})
