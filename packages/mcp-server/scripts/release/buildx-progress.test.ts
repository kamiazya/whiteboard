// The report this parser produces is the only evidence anyone has about the
// docker cache: publish-dry-run-docker.mjs prints buildx's own output solely on
// failure, so before this existed a green run said nothing about whether the
// 198s build hit the cache at all.
//
// That makes ONE case load-bearing above the rest: output the parser cannot
// read must report itself unreadable, never "0% cached". A confident zero is
// indistinguishable from a cache that is genuinely failing, and it would send
// a reader to rebuild the cache configuration that was fine.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface BuildStep {
  id: string
  name: string
  cached: boolean
  seconds: number | null
  layer: boolean
}
interface CacheReport {
  parsed: boolean
  steps: BuildStep[]
  stepCount: number
  layerCount: number
  cachedCount: number
  ranCount: number
  cacheHitRatio: number | null
  executedStepSeconds: number
  slowest: BuildStep[]
}

const { parseBuildxProgress, formatCacheReport } = (await import(
  join(__dirname, 'buildx-progress.mjs')
)) as {
  parseBuildxProgress: (output: unknown) => CacheReport
  formatCacheReport: (report: CacheReport, timing?: { elapsedSeconds?: number }) => string[]
}

// The shape `docker buildx build --progress=plain` writes to stderr. Both
// build paths in publish-dry-run-docker.mjs already pass that flag.
//
// SYNTHETIC, and deliberately recorded as such: no run in this repo's history
// has a real sample to pin, because the script only ever printed buildx output
// when the build failed and no build has failed since the job joined CI.
// Replace it with a captured run the first time the report says UNAVAILABLE —
// which is the whole reason that branch reports rather than returning zero.
const PLAIN_OUTPUT = `#1 [internal] load build definition from Dockerfile.server
#1 transferring dockerfile: 2.31kB done
#1 DONE 0.0s
#5 [base 1/4] FROM docker.io/library/node:24-slim@sha256:abc
#5 CACHED
#8 [base 2/4] RUN corepack enable
#8 CACHED
#12 [server 4/9] RUN pnpm install --frozen-lockfile
#12 DONE 45.3s
#13 [server 5/9] RUN pnpm --filter @kamiazya/whiteboard-mcp build:server
#13 DONE 92.7s
#20 exporting cache to GitHub Actions Cache
#20 DONE 12.1s
`

describe('the buildx cache report', () => {
  it('counts cached and ran steps', () => {
    const report = parseBuildxProgress(PLAIN_OUTPUT)
    expect(report.parsed).toBe(true)
    expect(report.stepCount).toBe(6)
    expect(report.ranCount).toBe(4)
  })

  it('takes the cache ratio over Dockerfile layers, not build overhead', () => {
    // `[internal] load build definition` and `exporting cache to …` are never
    // CACHED and always present, so counting them would depress the ratio by a
    // fixed amount and make two runs incomparable — which is the one thing a
    // trended number must not do. Six resolved steps here, four of them layers.
    const report = parseBuildxProgress(PLAIN_OUTPUT)
    expect(report.layerCount).toBe(4)
    expect(report.cachedCount).toBe(2)
    expect(report.cacheHitRatio).toBe(0.5)
    expect(report.steps.filter((s) => !s.layer).map((s) => s.name)).toEqual([
      '[internal] load build definition from Dockerfile.server',
      '#20',
    ])
  })

  it('has no ratio to report when it saw no layer at all', () => {
    // Overhead-only output is not a 0% cache; it is a build whose layers were
    // never described.
    const report = parseBuildxProgress('#20 exporting cache\n#20 DONE 1.0s\n')
    expect(report.parsed).toBe(true)
    expect(report.layerCount).toBe(0)
    expect(report.cacheHitRatio).toBeNull()
    expect(formatCacheReport(report)[0]).toContain('no Dockerfile layer seen')
  })

  it('sums the seconds of everything that ran, overhead included', () => {
    // A cached step has no duration to add. Overhead does, and it is counted:
    // the number has to account for where the build's time went, not just its
    // layers.
    expect(parseBuildxProgress(PLAIN_OUTPUT).executedStepSeconds).toBeCloseTo(150.1, 1)
  })

  it('calls the sum step TIME, never elapsed time', () => {
    // BuildKit runs steps in parallel, so the sum is total WORK and can exceed
    // the time anyone waited. Measured on this job's first real report: 214.4s
    // of step time inside a 200s build. Publishing the sum under a name that
    // reads like elapsed would overstate every run, in the one number the
    // report exists to trend — so elapsed is passed in, from a clock the
    // parser cannot see.
    const report = parseBuildxProgress(PLAIN_OUTPUT)
    expect(report).not.toHaveProperty('elapsedSeconds')
    const withElapsed = formatCacheReport(report, { elapsedSeconds: 121.5 }).join(' ')
    expect(withElapsed).toContain('121.5s elapsed')
    expect(withElapsed).toContain('150.1s of step time')
  })

  it('says only what it measured when no clock was passed', () => {
    const line = formatCacheReport(parseBuildxProgress(PLAIN_OUTPUT)).join(' ')
    expect(line).not.toContain('elapsed')
    expect(line).toContain('150.1s of step time')
  })

  it('names the slowest steps, worst first', () => {
    const slowest = parseBuildxProgress(PLAIN_OUTPUT).slowest
    expect(slowest[0]?.name).toContain('build:server')
    expect(slowest[1]?.name).toContain('pnpm install')
    expect(slowest.map((s) => s.seconds)).toEqual(
      [...slowest.map((s) => s.seconds)].sort((a, b) => (b ?? 0) - (a ?? 0)),
    )
  })

  it('reads a step whose name and result arrive on separate lines', () => {
    // The format never puts them together, so a parser that only looked at one
    // line would find every step nameless.
    const step = parseBuildxProgress(PLAIN_OUTPUT).steps.find((s) => s.id === '12')
    expect(step?.name).toContain('[server 4/9]')
    expect(step?.seconds).toBe(45.3)
  })

  it('strips the timestamp a downloaded CI log carries', () => {
    // Pinning a real sample means downloading it from the Actions API, which
    // prefixes every line. A parser that choked on that could never be given
    // the real output it exists to read.
    const stamped = PLAIN_OUTPUT.split('\n')
      .map((l) => (l ? `2026-09-06T07:00:00.1234567Z ${l}` : l))
      .join('\n')
    expect(parseBuildxProgress(stamped).stepCount).toBe(6)
  })

  it('reports itself unreadable rather than claiming 0% cached', () => {
    for (const input of ['', 'Successfully built abc123', null, undefined, 42]) {
      const report = parseBuildxProgress(input)
      expect(report.parsed, `input ${JSON.stringify(input)}`).toBe(false)
      // Not zero: a ratio of 0 is a measurement, and none was taken.
      expect(report.cacheHitRatio).toBeNull()
      expect(formatCacheReport(report).join(' ')).toContain('UNAVAILABLE')
    }
  })

  it('says how many steps it saw when it did read the output', () => {
    const lines = formatCacheReport(parseBuildxProgress(PLAIN_OUTPUT)).join(' ')
    expect(lines).toContain('2/4 layers CACHED (50%)')
    expect(lines).toContain('4 of 6 steps ran, 150.1s of step time')
  })
})
