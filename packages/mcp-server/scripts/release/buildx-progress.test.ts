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
      'exporting cache to GitHub Actions Cache',
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

// The report's first two real runs pinned a blind spot in the parser above.
// Two consecutive main builds, eighteen minutes apart, both said `0/15 layers
// CACHED` — and both spent 43% of the build (93.9s of 219.3s) in two steps the
// report could only call `#21` and `#22`. Those two are exactly where a cache
// backend reports itself: `exporting cache to GitHub Actions Cache` and, when
// it happens at all, `importing cache manifest from …`.
//
// The cause was the name pattern: a step was named only by a line starting
// `[`, which every Dockerfile layer does and no export step does. So the one
// question the report exists to answer — is the cache backend working? — was
// the one question its own output could not be read for.
const CACHE_BACKEND_TAIL = `#4 importing cache manifest from gha:3702480389601081481
#4 DONE 0.4s
#13 [fetched 3/3] RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
#13 0.234 Progress: resolved 1, reused 0, downloaded 0
#13 DONE 21.7s
#21 exporting to image
#21 exporting layers
#21 DONE 67.5s
#22 exporting to GitHub Actions Cache
#22 preparing build cache for export
#22 DONE 26.4s
`

describe('the cache backend the report exists to judge', () => {
  it('names a step whose first line is not a bracketed layer', () => {
    const report = parseBuildxProgress(CACHE_BACKEND_TAIL)
    const named = Object.fromEntries(report.steps.map((s) => [s.id, s.name]))
    expect(named['21']).toBe('exporting to image')
    expect(named['22']).toBe('exporting to GitHub Actions Cache')
    expect(named['4']).toBe('importing cache manifest from gha:3702480389601081481')
  })

  it('never mistakes a RUN step’s streamed output for its name', () => {
    // `#13 0.234 Progress: resolved 1 …` is the step's own stdout, prefixed
    // with seconds since the step began. Accepting any non-bracketed line as a
    // name would rename every RUN step after its first line of output.
    const step = parseBuildxProgress(CACHE_BACKEND_TAIL).steps.find((s) => s.id === '13')
    expect(step?.name).toContain('[fetched 3/3]')
  })

  it('answers whether the cache was imported and exported', () => {
    const report = parseBuildxProgress(CACHE_BACKEND_TAIL)
    expect(report.importSeen).toBe(true)
    expect(report.exportSeen).toBe(true)
  })

  it('says so when a build exported cache but imported none', () => {
    // The measured shape of both real runs: export ran, no import step existed
    // at all, every layer missed. A reader seeing `0/15` needs to know which
    // half of the round trip is broken, or the only move left is to guess.
    const exportOnly = CACHE_BACKEND_TAIL.split('\n')
      .filter((l) => !l.startsWith('#4 '))
      .join('\n')
    const report = parseBuildxProgress(exportOnly)
    expect(report.importSeen).toBe(false)
    expect(report.exportSeen).toBe(true)
    expect(formatCacheReport(report, { cacheBackend: 'gha' }).join(' ')).toContain(
      'import NOT seen',
    )
  })

  it('keeps a step that failed, rather than dropping it as unresolved', () => {
    // A cache export that ERRORs has no DONE line, so the resolution filter
    // discarded it — turning the loudest possible evidence into silence.
    const report = parseBuildxProgress(
      '#22 exporting to GitHub Actions Cache\n#22 ERROR: failed to configure gha cache exporter\n',
    )
    const step = report.steps.find((s) => s.id === '22')
    expect(step?.error).toBe(true)
    expect(step?.name).toBe('exporting to GitHub Actions Cache')
  })

  it('collects the warnings and errors buildx wrote outside any step', () => {
    const report = parseBuildxProgress(
      `WARNING: failed to get github token: unauthorized\n${CACHE_BACKEND_TAIL}`,
    )
    expect(report.diagnostics).toContain('WARNING: failed to get github token: unauthorized')
    expect(formatCacheReport(report).join('\n')).toContain('failed to get github token')
  })
})

describe('recognising the cache steps by their REAL names', () => {
  // The fixture above used to say `exporting cache to GitHub Actions Cache`,
  // written from memory when no run had ever produced a cache step to copy.
  // buildx actually writes `exporting to GitHub Actions Cache` — the word
  // order differs — so the first build that genuinely exported cache reported
  // `export NOT seen` while a 208.6s step named `exporting to GitHub Actions
  // Cache` sat in its own slowest list. A detector that reads the thing it is
  // detecting and still says no is worse than none: it is a measurement that
  // argues against the evidence beside it.
  //
  // Both spellings are matched now, and the names below are copied verbatim
  // from a run's uploaded metadata rather than recalled.
  it('sees the export whichever way buildx words it', () => {
    for (const name of ['exporting to GitHub Actions Cache', 'exporting cache to registry']) {
      const report = parseBuildxProgress(`#22 ${name}\n#22 DONE 26.4s\n`)
      expect(report.exportSeen, name).toBe(true)
    }
  })

  it('does not count the image export as a cache export', () => {
    // `exporting to docker image format` is the --load, and it is 64.4s of
    // every build. Counting it would report a working cache on every run.
    const report = parseBuildxProgress(
      '#21 exporting to docker image format\n#21 DONE 64.4s\n#23 importing to docker\n#23 DONE 24.3s\n',
    )
    expect(report.exportSeen).toBe(false)
    expect(report.importSeen).toBe(false)
  })
})

describe('a build with no cache backend at all', () => {
  // `type=gha` was configured, given credentials, and then REMOVED, because
  // measuring it end to end said it costs more than it saves on this image:
  //
  //   no cache            203.0s
  //   cold, exporting     406.1s   (export 208.6s)
  //   5/15 cached         482.7s   (export 273.6s)
  //
  // The export grew as the cache filled, and `[build 1/5] COPY . .` puts every
  // expensive stage behind the build context, which any source change
  // invalidates — and a source change in the compile closure is the only
  // reason this job runs at all. What stays cacheable is the base stage and
  // `pnpm fetch`, measured together at about 25s.
  //
  // So the report must say why every run reads 0%, or the next reader
  // rediscovers a broken cache that is not there.
  it('says the backend is absent rather than leaving 0% unexplained', () => {
    const lines = formatCacheReport(parseBuildxProgress(PLAIN_OUTPUT), {
      cacheBackend: 'none',
    }).join('\n')
    expect(lines).toContain('cache backend: none configured')
  })

  it('reports import and export only when a backend was asked for', () => {
    // Otherwise every run prints `import NOT seen, export NOT seen`, which
    // reads as a fault and is the intended state.
    const lines = formatCacheReport(parseBuildxProgress(PLAIN_OUTPUT), {
      cacheBackend: 'none',
    }).join('\n')
    expect(lines).not.toContain('import NOT seen')
  })

  it('still reports the round trip when a backend IS configured', () => {
    const lines = formatCacheReport(parseBuildxProgress(CACHE_BACKEND_TAIL), {
      cacheBackend: 'gha',
    }).join('\n')
    expect(lines).toContain('import seen, export seen')
  })
})
