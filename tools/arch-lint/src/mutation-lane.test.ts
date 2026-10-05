// The mutation lane is report-only, so nothing goes red when it stops
// working: a config Stryker cannot load, or a scheduled run cancelled at its
// timeout, looks exactly like a quiet week. These two guards are what make
// those two failures loud.

import { readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from '@typescript/typescript6'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

const STRYKER_PACKAGES = ['packages/canvas-render', 'packages/mcp-server'] as const

const { MUTATED, MINUTES, shardOf } = (await import(
  pathToFileURL(resolve(REPO_ROOT, 'packages/canvas-render/stryker-targets.mjs')).href
)) as {
  MUTATED: readonly string[]
  MINUTES: Readonly<Record<string, number>>
  shardOf: (
    files: readonly string[],
    spec: string | undefined,
    minutes?: Readonly<Record<string, number>>,
  ) => string[]
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

const MCP_SERVER = resolve(REPO_ROOT, 'packages/mcp-server')

const CONFIG_SOURCES = STRYKER_PACKAGES.map((pkg) => ({
  pkg,
  source: readFileSync(resolve(REPO_ROOT, pkg, 'stryker.config.mjs'), 'utf-8'),
}))

// The least reach the lane's selection may have: a test that imports a mutated
// module, or a module that does. Raising the selection's own depth only adds
// tests; lowering it below this drops the consumers' tests.
const FLOOR_DEPTH = 2

describe('every stryker lane initial run', () => {
  // The lanes are the packages that carry a config, so a third one cannot be
  // added without being sized.
  it('covers every package that carries a stryker config', () => {
    const carriers = readdirSync(resolve(REPO_ROOT, 'packages'), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          readdirSync(resolve(REPO_ROOT, 'packages', entry.name)).includes('stryker.config.mjs'),
      )
      .map((entry) => `packages/${entry.name}`)
    expect(carriers.sort()).toEqual([...STRYKER_PACKAGES].sort())
  })

  // Stryker abandons a lane when its initial run outlasts this bound, and its
  // default is 5 minutes: the run reads as a config error, not as slow. The
  // number records what it was sized from, like the workflow's timeouts below:
  // `measured: <date> <minutes> min`, the newest duration observed, with 1.5x
  // headroom over it.
  it.each(CONFIG_SOURCES)('$pkg names the timeout and the duration it was sized from', ({
    source,
  }) => {
    const minutes = /\n\s*dryRunTimeoutMinutes:\s*(\d+)\s*,/.exec(source)?.[1]
    expect(minutes, 'a dryRunTimeoutMinutes key in stryker.config.mjs').toBeDefined()
    const comment = /((?:\n\s*\/\/[^\n]*)+)\n\s*dryRunTimeoutMinutes:/.exec(source)?.[1]
    const measured = /measured: (\d{4}-\d{2}-\d{2}) (\d+) min\b/.exec(comment ?? '')
    expect(measured, 'a `measured: <date> <N> min` comment above it').not.toBeNull()
    expect(Number(minutes)).toBeGreaterThanOrEqual(Math.ceil(Number(measured?.[2]) * 1.5))
  })
})

describe('the contracts lane selection', () => {
  // The lane's include is derived from the source's import graph by a regex
  // over specifiers, cut at a depth. This resolves the same graph with the compiler, which
  // shares no code with it, so a specifier form the regex misses shows up as a
  // covering test the lane would silently not run.
  it('runs every test the compiler finds importing a mutated module or one that does', async () => {
    const { default: config } = (await import(
      pathToFileURL(resolve(MCP_SERVER, 'stryker.config.mjs')).href
    )) as { default: { mutate: string[] } }
    const { default: lane } = (await import(
      pathToFileURL(resolve(MCP_SERVER, 'vitest.stryker.config.ts')).href
    )) as { default: { test: { include: string[] } } }

    const sourceDir = join(MCP_SERVER, 'src')
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    }
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) return files(path)
        return entry.name.endsWith('.ts') ? [path] : []
      })
    const importers = new Map<string, string[]>()
    for (const file of files(sourceDir)) {
      const { importedFiles } = ts.preProcessFile(readFileSync(file, 'utf-8'), true, true)
      for (const { fileName } of importedFiles) {
        const target = ts.resolveModuleName(fileName, file, options, ts.sys).resolvedModule
          ?.resolvedFileName
        if (target?.startsWith(sourceDir + sep) !== true) continue
        importers.set(target, [...(importers.get(target) ?? []), file])
      }
    }
    const reached = new Set(config.mutate.map((path) => resolve(MCP_SERVER, path)))
    let frontier = [...reached]
    for (let level = 0; level < FLOOR_DEPTH; level++) {
      frontier = frontier
        .flatMap((file) => importers.get(file) ?? [])
        .filter((f) => !reached.has(f))
      for (const file of frontier) reached.add(file)
    }
    const covering = [...reached]
      .filter((file) => file.endsWith('.test.ts'))
      .map((file) => relative(MCP_SERVER, file).split(sep).join('/'))

    // Reached, not assumed: a closure that found nothing passes the check below.
    expect(covering.length).toBeGreaterThan(50)
    expect(covering.filter((file) => !lane.test.include.includes(file))).toEqual([])
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

type Step = { id?: string; run?: string; env?: Record<string, string> }
type Job = {
  'timeout-minutes'?: number
  strategy?: { matrix?: { shard?: number[]; include?: unknown } }
  steps?: Step[]
}
const JOBS = (parseYaml(WORKFLOW) as { jobs: Record<string, Job> }).jobs

/** The weekly matrix's leg count, which the PR lane deals against too. */
const LEGS = JOBS.weekly?.strategy?.matrix?.shard?.length ?? 0

const minutesOf = (files: readonly string[]) =>
  files.reduce((sum, file) => sum + (MINUTES[file] ?? Number.NaN), 0)

describe('the weekly lane shards', () => {
  it('deal every curated file to exactly one leg, whatever the leg count', () => {
    expect(MUTATED.length).toBeGreaterThan(5)
    for (let total = 1; total <= MUTATED.length + 3; total++) {
      const dealt = Array.from({ length: total }, (_, k) => shardOf(MUTATED, `${k + 1}/${total}`))
      expect(dealt.flat().sort(), `${total} legs`).toEqual([...MUTATED].sort())
    }
  })

  // A leg's run time is its files' mutants times the tests each one runs, and
  // a file's share of that differs by two orders of magnitude between files
  // of a similar mutant count. Dealt by count, the legs of one measured run
  // ranged from 11 to 60 minutes.
  it('deal by recorded minutes, so one heavy file is not paired with others', () => {
    // Listed light first, so a deal that walks the list in order pairs the
    // heavy file with a light one; heaviest first leaves it alone.
    const minutes = { b: 3, c: 3, d: 4, a: 10 }
    const files = Object.keys(minutes)
    expect(shardOf(files, '1/2', minutes)).toEqual(['a'])
    expect(shardOf(files, '2/2', minutes)).toEqual(['b', 'c', 'd'])
  })

  // The table is a measurement of THIS list, so it cannot hold a file the lane
  // no longer mutates, and a file without a figure cannot be dealt at all.
  it('have a recorded figure for every curated file, and none for any other', () => {
    expect(Object.keys(MINUTES).sort()).toEqual([...MUTATED].sort())
    for (const [file, minutes] of Object.entries(MINUTES)) {
      expect(minutes, file).toBeGreaterThan(0)
    }
    expect(() => shardOf(['src/unmeasured.ts'], '1/2')).toThrow(/src\/unmeasured\.ts/)
  })

  // The leg the timeout is sized from is the heaviest, so the deal is only as
  // good as its worst leg. One file heavier than a fair share has to sit
  // alone; any leg holding more than one file stays near the fair share.
  it('keep every leg that holds more than one file within 1.15x of a fair share', () => {
    expect(LEGS).toBeGreaterThan(1)
    const fair = minutesOf(MUTATED) / LEGS
    for (let k = 1; k <= LEGS; k++) {
      const leg = shardOf(MUTATED, `${k}/${LEGS}`)
      if (leg.length > 1) expect(minutesOf(leg), leg.join(', ')).toBeLessThanOrEqual(fair * 1.15)
    }
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
    const shards = JOBS.weekly?.strategy?.matrix?.shard ?? []
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, i) => i + 1))
    const spec = JOBS.weekly?.steps?.find((step) => step.env?.MUTATION_SHARD !== undefined)?.env
      ?.MUTATION_SHARD
    expect(spec).toMatch(/^\$\{\{ matrix\.shard \}\}\/\$\{\{ strategy\.job-total \}\}$/)
  })
})

describe('the PR lane', () => {
  // A PR leg mutates the changed files of ONE weekly leg, so it can never run
  // longer than that leg — which is what lets both share one sizing. That
  // holds only while the plan deals against the weekly leg count.
  it('deals the changed files into the weekly legs', () => {
    const plan = JOBS['pr-plan']?.steps?.find((step) => step.run?.includes('mutation-scope.mjs'))
    expect(plan?.run, 'a pr-plan step that runs mutation-scope.mjs').toBeDefined()
    expect(/--legs (\d+)\b/.exec(plan?.run ?? '')?.[1]).toBe(String(LEGS))
    expect(JOBS.pr?.strategy?.matrix?.include).toMatch(/fromJSON\(needs\.pr-plan\.outputs\.legs\)/)
  })

  // Stryker writes its report only at the end, so a run the job limit cuts
  // off leaves nothing to comment from. The run carries its own, shorter
  // budget so the leg can still say how far it got.
  it('stops Stryker on its own budget, with time left under the job limit', () => {
    const mutate = JOBS.pr?.steps?.find((step) => step.run?.includes('stryker run'))
    expect(mutate?.run).toMatch(/timeout [^\n]*"\$\{BUDGET_MINUTES\}m" pnpm exec stryker run/)
    const budget = Number(mutate?.env?.BUDGET_MINUTES)
    expect(budget).toBeGreaterThan(0)
    expect(budget + 5).toBeLessThanOrEqual(JOBS.pr?.['timeout-minutes'] ?? 0)
  })
})
