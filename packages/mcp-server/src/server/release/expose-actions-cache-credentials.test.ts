// The docker layer cache was configured, ran on every image build, and hit
// nothing: 0/15 layers across four measured runs, ~200s rebuilt every time.
// The cache report merged alongside this named the cause — `cache credentials:
// none of ACTIONS_RUNTIME_TOKEN, ACTIONS_CACHE_URL, ACTIONS_RESULTS_URL,
// ACTIONS_CACHE_SERVICE_V2 are set`. Docker's `gha` backend falls back to
// those, and its own documentation says an inline `docker buildx` invocation
// must expose them by hand; `dry-run-docker` runs buildx from a `run:` step,
// where the runner does not provide them.
//
// This action is what provides them. It is local rather than the third-party
// one Docker's docs suggest for one measured reason: that action's ten lines
// include `core.info(`${key}=${process.env[key]}`)` over every ACTIONS_*
// variable, with no setSecret and no add-mask anywhere in its source — checked
// at its v4.0.0 tag and on its default branch. This repository is public, so
// its job logs are too.

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')
const ACTION = join(ROOT, '.github/actions/expose-actions-cache-credentials/index.js')

interface Plan {
  present: string[]
  absent: string[]
  secret: string[]
}
const { planExposure, envFileLines, maskCommands, announce } = (await import(
  pathToFileURL(ACTION).href
)) as {
  planExposure: (env: Record<string, string | undefined>) => Plan
  envFileLines: (plan: Plan, env: Record<string, string | undefined>, delimiter: string) => string[]
  maskCommands: (plan: Plan, env: Record<string, string | undefined>) => string[]
  announce: (plan: Plan) => string[]
}

const TOKEN = 'eyJhbGciOi.super-secret-runtime-jwt.signature'
const FULL_ENV = {
  ACTIONS_RUNTIME_TOKEN: TOKEN,
  ACTIONS_CACHE_URL: 'https://cache.example/',
  ACTIONS_RESULTS_URL: 'https://results.example/',
  ACTIONS_CACHE_SERVICE_V2: 'true',
  GITHUB_TOKEN: 'unrelated',
}

describe('exposing the Actions cache credentials to an inline buildx step', () => {
  it('carries exactly the four the gha backend falls back to', () => {
    // Not every ACTIONS_* variable. The four are what Docker's backend
    // documents as its fallbacks, and they are the four the cache report
    // already names — so a variable this misses is reported absent rather
    // than silently missing.
    const plan = planExposure(FULL_ENV)
    expect(plan.present).toEqual([
      'ACTIONS_RUNTIME_TOKEN',
      'ACTIONS_CACHE_URL',
      'ACTIONS_RESULTS_URL',
      'ACTIONS_CACHE_SERVICE_V2',
    ])
    expect(plan.present).not.toContain('GITHUB_TOKEN')
    expect(plan.absent).toEqual([])
  })

  it('reports what the runner did not give it, rather than failing', () => {
    // A job outside Actions, or a future runner that renames one, should leave
    // the build working and the report saying the cache is unconfigured.
    const plan = planExposure({ ACTIONS_CACHE_URL: 'https://cache.example/' })
    expect(plan.present).toEqual(['ACTIONS_CACHE_URL'])
    expect(plan.absent).toContain('ACTIONS_RUNTIME_TOKEN')
  })

  it('never puts a credential in anything it prints', () => {
    // The whole reason this action is local. `announce` is its only output.
    const plan = planExposure(FULL_ENV)
    const printed = announce(plan).join('\n')
    expect(printed).not.toContain(TOKEN)
    expect(printed).toContain('ACTIONS_RUNTIME_TOKEN')
  })

  it('masks the token before it can reach a log', () => {
    const plan = planExposure(FULL_ENV)
    expect(maskCommands(plan, FULL_ENV)).toEqual([`::add-mask::${TOKEN}`])
  })

  it('does not mask the URLs, which are not credentials', () => {
    // Masking them would replace every occurrence with *** and make the job
    // log unreadable for no gain.
    const plan = planExposure(FULL_ENV)
    expect(maskCommands(plan, FULL_ENV).join('\n')).not.toContain('cache.example')
  })

  it('writes GITHUB_ENV in the delimited form, so no value can forge a line', () => {
    // `KEY=value` is injectable by any value carrying a newline. The runner's
    // heredoc form is not, and costs two lines.
    const lines = envFileLines(planExposure(FULL_ENV), FULL_ENV, 'DELIM')
    expect(lines.slice(0, 3)).toEqual(['ACTIONS_RUNTIME_TOKEN<<DELIM', TOKEN, 'DELIM'])
  })

  it('refuses rather than emitting a value that contains the delimiter', () => {
    const env = { ACTIONS_CACHE_URL: 'has DELIM inside' }
    expect(() => envFileLines(planExposure(env), env, 'DELIM')).toThrow(/delimiter/i)
  })
})

describe('the workflow that needs those credentials', () => {
  const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8')
  const dryRunDocker = ci.slice(ci.indexOf('\n  dry-run-docker:'), ci.indexOf('\n  ci-gate:'))

  it('exposes them BEFORE the step that shells out to buildx', () => {
    // Order is the whole point: the build reads them from its own environment,
    // so an action placed after it would be a no-op that still looked wired.
    const exposeAt = dryRunDocker.indexOf('./.github/actions/expose-actions-cache-credentials')
    const buildAt = dryRunDocker.indexOf('pnpm publish:dry-run:docker')
    expect(exposeAt).toBeGreaterThan(-1)
    expect(buildAt).toBeGreaterThan(-1)
    expect(exposeAt).toBeLessThan(buildAt)
  })

  it('skips it on the same condition as the build it serves', () => {
    // The job gates its docker steps individually; an ungated exposure step
    // would run on every pull request that skips the image entirely.
    const step = dryRunDocker.slice(
      dryRunDocker.indexOf('- name: Expose Actions cache credentials'),
      dryRunDocker.indexOf('- name: Docker build dry-run'),
    )
    expect(step).toContain("if: steps.detect.outputs.docker == 'true'")
  })
})

describe('the action as the runner actually runs it', () => {
  // The unit cases above import the module through vitest, which transforms it
  // — so they passed against a file the runner could not execute at all. The
  // repository root declares `"type": "module"`, which the action inherits,
  // and its first CI run died on `require is not defined in ES module scope`
  // with every one of those cases green. `node --check` did not catch it
  // either: it parses, and CommonJS is what it parses as.
  //
  // Running the real file in a real subprocess is the only shape that fails
  // when the file will not run. It costs a process; the alternative cost a CI
  // round trip and a red check.
  it('runs, masks the token, and writes GITHUB_ENV', () => {
    const envFile = join(mkdtempSync(join(tmpdir(), 'expose-creds-')), 'github.env')
    writeFileSync(envFile, '')
    const result = spawnSync(process.execPath, [ACTION], {
      encoding: 'utf-8',
      env: { ...FULL_ENV, GITHUB_ENV: envFile, PATH: process.env.PATH ?? '' },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`::add-mask::${TOKEN}`)
    expect(result.stdout).toContain('exposed to later steps: ACTIONS_RUNTIME_TOKEN')

    const written = readFileSync(envFile, 'utf-8')
    expect(written).toContain(TOKEN)
    expect(written).toMatch(/ACTIONS_RUNTIME_TOKEN<<ghenv_[0-9a-f-]+\n/)
  })

  it('runs and says so when the runner provided nothing', () => {
    // A job outside Actions must not fail the build; the report says the cache
    // is unconfigured instead.
    const result = spawnSync(process.execPath, [ACTION], {
      encoding: 'utf-8',
      env: { PATH: process.env.PATH ?? '' },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('not provided by the runner: ACTIONS_RUNTIME_TOKEN')
  })
})
