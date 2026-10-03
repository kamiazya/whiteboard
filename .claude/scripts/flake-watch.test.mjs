#!/usr/bin/env node
// flake-watch.mjs as the SessionStart hook runs it, against a stand-in `gh`: the failures that
// are not vitest annotations reach the output through the real fetch, paging and cache path.
//
// Run with: pnpm test:scripts (also wired into the CI "check" job).

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'flake-watch.mjs')
const ROOT = resolve(dirname(SCRIPT), '../..')

// Run ids no real Actions run has, so the per-run cache this writes can be removed by name.
const FAILED_RELEASE = '990000000001'
const LATER_RELEASE = '990000000002'

const FAKE_GH = `#!/usr/bin/env node
const args = process.argv.slice(2)
const url = args.find((arg) => arg.startsWith('repos/')) ?? ''
const out = (value) => process.stdout.write(JSON.stringify(value))
if (args[0] === 'run') out([])
else if (url.includes('/workflows/release.yml/runs'))
  out({
    total: 2,
    runs: [
      { runId: '${LATER_RELEASE}', createdAt: '2099-01-02T00:00:00Z', conclusion: 'success', event: 'push', title: 'fix: an ordinary push' },
      { runId: '${FAILED_RELEASE}', createdAt: '2099-01-01T00:00:00Z', conclusion: 'failure', event: 'push', title: 'chore: release main (#1)' },
    ],
  })
else if (url.includes('/workflows/mutation.yml/runs'))
  out({
    total: 2,
    runs: [
      { runId: '3', createdAt: '2099-01-02T00:00:00Z', conclusion: 'cancelled', event: 'schedule', title: 'Mutation' },
      { runId: '2', createdAt: '2098-12-01T00:00:00Z', conclusion: 'success', event: 'schedule', title: 'Mutation' },
    ],
  })
else if (url.includes('/workflows/audit.yml/runs')) out({ total: 0, runs: [] })
else if (url.endsWith('/actions/runs/${FAILED_RELEASE}/jobs'))
  out([{ name: 'docker-publish-sign', conclusion: 'failure' }, { name: 'publish-mcp', conclusion: 'success' }])
else process.exit(1)
`

test('reports a failed publish job and a scheduled lane with no later success, once', async (t) => {
  if (process.platform === 'win32') return t.skip('the stand-in gh is an executable script')
  const bin = mkdtempSync(join(tmpdir(), 'flake-watch-gh-'))
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim()
  t.after(() => {
    rmSync(bin, { recursive: true, force: true })
    rmSync(join(commonDir, 'flake-watch', `${FAILED_RELEASE}.v1-jobs-failure.json`), { force: true })
  })
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)

  const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, '--quiet'], {
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
  })

  assert.match(stdout, /release: docker-publish-sign failure on 2099-01-01 \(run 990000000001\)/)
  assert.doesNotMatch(stdout, /publish-mcp/)
  assert.match(stdout, /mutation: 1 run\(s\) failed or were cancelled since .*run 3/)
  assert.doesNotMatch(stdout, /audit/)
  assert.equal(stdout.match(/\[flake-watch\]/g)?.length, 1, 'one block, not one line per finding')
})
