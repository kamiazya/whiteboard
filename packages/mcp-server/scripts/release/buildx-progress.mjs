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
 * @typedef {{ id: string, name: string, cached: boolean, seconds: number | null, layer: boolean }} BuildStep
 * @typedef {{
 *   parsed: boolean,
 *   steps: BuildStep[],
 *   stepCount: number,
 *   layerCount: number,
 *   cachedCount: number,
 *   ranCount: number,
 *   cacheHitRatio: number | null,
 *   ranSeconds: number,
 *   slowest: BuildStep[],
 * }} CacheReport
 */

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
  /** @type {Map<string, {name: string, cached: boolean, seconds: number | null}>} */
  const steps = new Map()
  for (const raw of String(output ?? '').split('\n')) {
    // GitHub prefixes each log line with a timestamp; strip it before matching.
    const line = raw.replace(/^\S+Z\s/, '').trim()
    const idMatch = line.match(/^#(\d+)\s+(.*)$/)
    if (!idMatch) continue
    const [, id, rest] = idMatch
    const entry = steps.get(id) ?? { name: '', cached: false, seconds: null }
    const named = rest.match(/^(\[[^\]]*\].*)$/)
    if (named && entry.name === '') entry.name = named[1]
    if (/^CACHED\b/.test(rest)) entry.cached = true
    const done = rest.match(/^DONE\s+([\d.]+)s/)
    if (done) entry.seconds = Number(done[1])
    steps.set(id, entry)
  }

  const resolved = [...steps.entries()]
    .filter(([, s]) => s.cached || s.seconds !== null)
    .map(([id, s]) => ({
      id,
      name: s.name || `#${id}`,
      cached: s.cached,
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
      ranSeconds: 0,
      slowest: [],
    }
  }

  const layers = resolved.filter((s) => s.layer)
  const cachedCount = layers.filter((s) => s.cached).length
  // Seconds are summed over EVERYTHING that ran, layer or not, so the number
  // still accounts for the build's wall clock rather than only part of it.
  const ran = resolved.filter((s) => !s.cached)
  const ranSeconds = ran.reduce((sum, s) => sum + (s.seconds ?? 0), 0)
  return {
    parsed: true,
    steps: resolved,
    stepCount: resolved.length,
    layerCount: layers.length,
    cachedCount,
    ranCount: ran.length,
    cacheHitRatio: layers.length === 0 ? null : Number((cachedCount / layers.length).toFixed(3)),
    ranSeconds: Number(ranSeconds.toFixed(1)),
    slowest: [...ran].sort((a, b) => (b.seconds ?? 0) - (a.seconds ?? 0)).slice(0, 5),
  }
}

/** The report as lines a reader can scan in a CI log. */
export function formatCacheReport(report) {
  if (!report.parsed) {
    return [
      '[publish-dry-run:docker] cache report UNAVAILABLE: no buildx step lines were parsed.',
      '  The build ran, but its progress output did not match the `#<id> [stage] …` shape',
      '  this report reads. Re-run with WHITEBOARD_DOCKER_BUILD_LOG=1 to see the raw output.',
    ]
  }
  const ratio =
    report.cacheHitRatio === null
      ? 'no Dockerfile layer seen'
      : `${report.cachedCount}/${report.layerCount} layers CACHED (${Math.round(report.cacheHitRatio * 100)}%)`
  const lines = [
    `[publish-dry-run:docker] cache report: ${ratio}; ` +
      `${report.ranCount} of ${report.stepCount} steps ran, ${report.ranSeconds}s total`,
  ]
  for (const step of report.slowest) {
    lines.push(`  ${String(step.seconds ?? 0).padStart(7)}s  ${step.name}`)
  }
  return lines
}
