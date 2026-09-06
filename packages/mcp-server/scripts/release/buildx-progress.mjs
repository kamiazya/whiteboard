#!/usr/bin/env node

// Turn `docker buildx --progress=plain` output into a CACHE REPORT.
//
// The image build is the longest step in ci.yml's dry-run-docker job — 198s of
// a 270s job, measured — and it runs with `--cache-from/--cache-to type=gha`.
// Whether that cache is doing anything was, until this module, unanswerable:
// publish-dry-run-docker.mjs captures buildx's output and prints it only when
// the build FAILS, so every green run threw the evidence away. 198s might be a
// warm cache doing its best or a cold one hitting nothing, and no number
// anywhere told them apart.
//
// A report rather than a raw dump, for two reasons: the script's contract is
// that full build logs never reach stdout, and what a reader actually needs is
// a number that can be compared with last week's — not a wall of text.

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   cached: boolean,
 *   error: boolean,
 *   seconds: number | null,
 *   layer: boolean,
 * }} BuildStep
 * @typedef {{
 *   parsed: boolean,
 *   steps: BuildStep[],
 *   stepCount: number,
 *   layerCount: number,
 *   cachedCount: number,
 *   ranCount: number,
 *   cacheHitRatio: number | null,
 *   executedStepSeconds: number,
 *   slowest: BuildStep[],
 *   importSeen: boolean,
 *   exportSeen: boolean,
 *   diagnostics: string[],
 * }} CacheReport
 */

// A step's own stdout is streamed back prefixed with seconds since the step
// began — `#13 0.234 Progress: resolved 1 …`. It is the one thing that looks
// like a name and is not, so it is excluded by shape rather than by guessing.
const STATUS_LINE = /^(DONE|CACHED|ERROR|WARNING|WARN|CANCELED)\b/
const STREAMED_OUTPUT = /^\d+(\.\d+)?\s/

/**
 * Is this the line that NAMES a step?
 *
 * It used to be "starts with `[`", which every Dockerfile layer does and no
 * cache step does — so `exporting cache to GitHub Actions Cache` and
 * `importing cache manifest from …` were recorded as `#21` and `#22`. Two real
 * runs then reported 0% cached with 43% of the build sitting inside those two
 * nameless steps, which is precisely the evidence needed to tell a broken
 * cache backend from a cold one.
 *
 * @param {string} rest the line with its `#<id> ` prefix removed
 */
function isNameLine(rest) {
  return rest !== '' && !STATUS_LINE.test(rest) && !STREAMED_OUTPUT.test(rest)
}

/**
 * Is this step a Dockerfile LAYER, as opposed to build overhead?
 *
 * The cache ratio is over layers alone. `[internal] load build definition`,
 * `exporting cache to GitHub Actions Cache` and friends are never CACHED and
 * always present, so counting them would depress the ratio by a fixed amount
 * and make two runs incomparable — the one thing a trended number must not do.
 * A layer's name carries its position in its stage, `[server 4/9]`; the
 * internal steps carry no `n/m`.
 *
 * @param {string} name
 */
function isLayer(name) {
  return /^\[[^\]]*\b\d+\/\d+\]/.test(name)
}

/**
 * `--progress=plain` writes one `#<id>` prefixed line per event:
 *
 *   #12 [server 4/9] RUN pnpm install --frozen-lockfile
 *   #12 CACHED
 *   #13 [server 5/9] RUN pnpm --filter ... build
 *   #13 DONE 45.3s
 *
 * A step is named by its first `[stage n/m] …` line and resolved by a later
 * `CACHED` or `DONE <n>s`. Steps with neither (still running when the build
 * died) are dropped, since a report is about what finished.
 *
 * @param {string} output buildx stderr
 * @returns {CacheReport}
 */
export function parseBuildxProgress(output) {
  /** @type {Map<string, {name: string, cached: boolean, error: boolean, seconds: number | null}>} */
  const steps = new Map()
  /** @type {string[]} */
  const diagnostics = []
  for (const raw of String(output ?? '').split('\n')) {
    // GitHub prefixes each log line with a timestamp; strip it before matching.
    const line = raw.replace(/^\S+Z\s/, '').trim()
    const idMatch = line.match(/^#(\d+)\s+(.*)$/)
    if (!idMatch) {
      // buildx writes its own failures with no step to attach them to. They
      // are the shortest path from "0% cached" to a cause, so they are kept
      // even though they belong to no step.
      if (/^(WARNING|ERROR)\b/.test(line)) addDiagnostic(diagnostics, line)
      continue
    }
    const [, id, rest] = idMatch
    const entry = steps.get(id) ?? { name: '', cached: false, error: false, seconds: null }
    if (entry.name === '' && isNameLine(rest)) entry.name = rest
    if (/^CACHED\b/.test(rest)) entry.cached = true
    if (/^ERROR\b/.test(rest)) {
      entry.error = true
      addDiagnostic(diagnostics, `#${id} ${rest}`)
    }
    const done = rest.match(/^DONE\s+([\d.]+)s/)
    if (done) entry.seconds = Number(done[1])
    steps.set(id, entry)
  }

  // A step that ERRORed has no DONE line. Resolving on duration alone dropped
  // it, which turned the loudest evidence a build can produce into silence.
  const resolved = [...steps.entries()]
    .filter(([, s]) => s.cached || s.seconds !== null || s.error)
    .map(([id, s]) => ({
      id,
      name: s.name || `#${id}`,
      cached: s.cached,
      error: s.error,
      seconds: s.seconds,
      layer: isLayer(s.name),
    }))

  // Not "0% cached": a parser that stopped matching would otherwise report a
  // confident zero, which reads exactly like a cache that is failing. The
  // caller says so instead of publishing a number it did not measure.
  if (resolved.length === 0) {
    return {
      parsed: false,
      steps: [],
      stepCount: 0,
      layerCount: 0,
      cachedCount: 0,
      ranCount: 0,
      cacheHitRatio: null,
      executedStepSeconds: 0,
      slowest: [],
      importSeen: false,
      exportSeen: false,
      diagnostics,
    }
  }

  const layers = resolved.filter((s) => s.layer)
  const cachedCount = layers.filter((s) => s.cached).length
  // Seconds are summed over EVERYTHING that ran, layer or not, so the number
  // still accounts for the build's wall clock rather than only part of it.
  const ran = resolved.filter((s) => !s.cached)
  const executedStepSeconds = ran.reduce((sum, s) => sum + (s.seconds ?? 0), 0)
  return {
    parsed: true,
    steps: resolved,
    stepCount: resolved.length,
    layerCount: layers.length,
    cachedCount,
    ranCount: ran.length,
    cacheHitRatio: layers.length === 0 ? null : Number((cachedCount / layers.length).toFixed(3)),
    executedStepSeconds: Number(executedStepSeconds.toFixed(1)),
    slowest: [...ran].sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0)).slice(0, 5),
    // Both words, in either order, because buildx uses both orders and the
    // first real export was missed by a detector that only knew one:
    // `exporting to GitHub Actions Cache` against a pattern reading
    // `exporting cache`. `exporting to docker image format` and `importing to
    // docker` are the --load and carry no `cache`, so they stay out.
    importSeen: resolved.some((s) => /\bimporting\b.*\bcache\b/i.test(s.name)),
    exportSeen: resolved.some((s) => /\bexporting\b.*\bcache\b/i.test(s.name)),
    diagnostics,
  }
}

/**
 * Diagnostics are buildx's own text, so they are capped on both axes: a build
 * can repeat a warning per step, and a single line can carry a whole URL.
 *
 * @param {string[]} into
 * @param {string} line
 */
function addDiagnostic(into, line) {
  const trimmed = line.length > 300 ? `${line.slice(0, 300)}…` : line
  if (into.length < 10 && !into.includes(trimmed)) into.push(trimmed)
}

/**
 * The report as lines a reader can scan in a CI log.
 *
 * `elapsedSeconds` is passed in because the parser cannot know it: BuildKit
 * runs steps in PARALLEL, so summing their durations is the total WORK, not
 * the time anyone waited. Measured on this job's first real report, the two
 * differ by more than rounding — 214.4s of step time inside a 200s step — so
 * publishing the sum under a name that reads like elapsed time would overstate
 * the build every run, in the one number the whole report exists to trend.
 *
 * @param {CacheReport} report
 * @param {{
 *   elapsedSeconds?: number,
 *   cacheBackend?: 'gha' | 'none',
 * }} [timing]
 */
export function formatCacheReport(report, timing = {}) {
  if (!report.parsed) {
    return [
      '[publish-dry-run:docker] cache report UNAVAILABLE: no buildx step lines were parsed.',
      '  The build ran, but its progress output did not match the `#<id> [stage] …` shape',
      '  this report reads. Re-run with WHITEBOARD_DOCKER_BUILD_LOG=1 to see the raw output.',
      ...report.diagnostics.map((d) => `  ${d}`),
    ]
  }
  const ratio =
    report.cacheHitRatio === null
      ? 'no Dockerfile layer seen'
      : `${report.cachedCount}/${report.layerCount} layers CACHED (${Math.round(report.cacheHitRatio * 100)}%)`
  const elapsed =
    typeof timing.elapsedSeconds === 'number'
      ? `${timing.elapsedSeconds.toFixed(1)}s elapsed, `
      : ''
  const lines = [
    `[publish-dry-run:docker] cache report: ${ratio}; ` +
      `${report.ranCount} of ${report.stepCount} steps ran, ` +
      `${elapsed}${report.executedStepSeconds}s of step time`,
  ]
  // Why every run reads 0%, said out loud. Without this the ratio looks like
  // a cache that is failing, and the next reader goes looking for the fault
  // that was deliberately removed — see this module's header for the numbers.
  //
  // When a backend IS configured, which HALF of the round trip ran: a build
  // that exports and imports nothing misses every layer while looking, from
  // the ratio alone, exactly like a build whose inputs all changed, and the
  // two want opposite fixes.
  if (timing.cacheBackend === 'none') {
    lines.push('  cache backend: none configured — layers rebuild every run, by decision')
  } else if (timing.cacheBackend) {
    lines.push(
      `  cache backend: import ${report.importSeen ? 'seen' : 'NOT seen'}, ` +
        `export ${report.exportSeen ? 'seen' : 'NOT seen'}`,
    )
  }
  for (const step of report.slowest) {
    lines.push(`  ${String(step.seconds ?? 0).padStart(7)}s  ${step.name}`)
  }
  for (const diagnostic of report.diagnostics) {
    lines.push(`  ${diagnostic}`)
  }
  return lines
}
