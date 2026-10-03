// The mutation lane is report-only, so nothing goes red when it stops
// working: a config Stryker cannot load, or a scheduled run cancelled at its
// timeout, looks exactly like a quiet week. These two guards are what make
// those two failures loud.

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

const STRYKER_PACKAGES = ['packages/canvas-render', 'packages/mcp-server'] as const

const { MUTATED, shardOf } = (await import(
  pathToFileURL(resolve(REPO_ROOT, 'packages/canvas-render/stryker-targets.mjs')).href
)) as {
  MUTATED: readonly string[]
  shardOf: (files: readonly string[], spec: string | undefined) => string[]
}

const configs = await Promise.all(
  STRYKER_PACKAGES.map(async (pkg) => {
    const { default: config } = (await import(
      pathToFileURL(resolve(REPO_ROOT, pkg, 'stryker.config.mjs')).href
    )) as { default: { plugins?: unknown[] } }
    return { pkg, plugins: config.plugins ?? [] }
  }),
)

describe('stryker configs', () => {
  // Stryker loads a plugin from its own location in the pnpm store, where a
  // workspace package's dependency does not resolve, so a bare name fails with
  // "Cannot find TestRunner plugin" before a single mutant is made.
  it.each(configs)('$pkg names every plugin by absolute path', ({ plugins }) => {
    expect(plugins.length).toBeGreaterThan(0)
    const bare = plugins.filter((plugin) => typeof plugin !== 'string' || !isAbsolute(plugin))
    expect(bare).toEqual([])
  })
})

const WORKFLOW = readFileSync(resolve(REPO_ROOT, '.github/workflows/mutation.yml'), 'utf-8')

/** Every `timeout-minutes:` line, with its job and the comment block directly above it. */
function timeouts(): { job: string; minutes: number; comment: string }[] {
  const lines = WORKFLOW.split('\n')
  return lines.flatMap((text, index) => {
    const match = /^\s*timeout-minutes:\s*(\d+)\s*$/.exec(text)
    if (match === null) return []
    const above: string[] = []
    for (let i = index - 1; i >= 0 && /^\s*#/.test(lines[i] ?? ''); i--)
      above.unshift(lines[i] ?? '')
    const job = lines
      .slice(0, index)
      .reverse()
      .map((line) => /^ {2}([\w-]+):\s*$/.exec(line)?.[1])
      .find((id) => id !== undefined)
    return [{ job: job ?? '?', minutes: Number(match[1]), comment: above.join('\n') }]
  })
}

describe('mutation.yml timeouts', () => {
  it('are read from the workflow', () => {
    expect(timeouts().length).toBeGreaterThanOrEqual(2)
  })

  // A scheduled run that hits its timeout is cancelled, uploads nothing, and
  // does not fail anything. The workflow cannot measure itself, so the number
  // records what it was sized from: `# measured: <date> <minutes> min`, the
  // newest duration observed, and the limit must leave 1.5x headroom over it.
  it.each(timeouts())('job $job records the duration it was sized from', ({ minutes, comment }) => {
    const match = /# measured: (\d{4}-\d{2}-\d{2}) (\d+) min\b/.exec(comment)
    expect(match, 'a `# measured: <date> <N> min` comment above the timeout').not.toBeNull()
    expect(minutes).toBeGreaterThanOrEqual(Math.ceil(Number(match?.[2]) * 1.5))
  })
})

describe('the weekly lane shards', () => {
  it('deal every curated file to exactly one leg, whatever the leg count', () => {
    expect(MUTATED.length).toBeGreaterThan(5)
    for (let total = 1; total <= MUTATED.length + 3; total++) {
      const dealt = Array.from({ length: total }, (_, k) => shardOf(MUTATED, `${k + 1}/${total}`))
      expect(dealt.flat().sort(), `${total} legs`).toEqual([...MUTATED].sort())
    }
  })

  // The list is grouped by subject with its heavy files at both ends, so a
  // contiguous slice or a plain round-robin would stack them on one leg.
  it('deal in a snake, so a leg gets a spread of the list', () => {
    const files = 'abcdefghijkl'.split('')
    expect(shardOf(files, '1/4')).toEqual(['a', 'h', 'i'])
    expect(shardOf(files, '4/4')).toEqual(['d', 'e', 'l'])
  })

  it('run everything when no leg is named, and refuse a spec that names none', () => {
    expect(shardOf(MUTATED, undefined)).toEqual([...MUTATED])
    for (const spec of ['0/4', '5/4', '1/0', 'x', '2']) {
      expect(() => shardOf(MUTATED, spec), spec).toThrow(/shard spec/)
    }
  })

  // The workflow decides how many legs run; the config decides which files a
  // leg gets. They only agree if every leg is numbered 1..n and told n.
  it('are numbered 1..n in the workflow and told n by the job', () => {
    const weekly = (
      parseYaml(WORKFLOW) as {
        jobs: Record<
          string,
          {
            strategy?: { matrix?: { shard?: number[] } }
            steps?: { env?: Record<string, string> }[]
          }
        >
      }
    ).jobs.weekly
    const shards = weekly?.strategy?.matrix?.shard ?? []
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, i) => i + 1))
    expect(shards.length).toBeGreaterThan(1)
    const spec = weekly?.steps?.find((step) => step.env?.MUTATION_SHARD !== undefined)?.env
      ?.MUTATION_SHARD
    expect(spec).toMatch(/^\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}$/)
  })
})
