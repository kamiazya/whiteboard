// `pnpm --filter <pkg> test` is the command the test-layer-selection skill
// gives for "run this package", because a single `--project` misses the
// sibling project a package splits into. That only holds if each package's
// `test` script runs every vitest config the root `vitest.config.ts` registers
// for it. A package with no `test` script makes the filter command exit 0
// having run nothing, and a script naming one of two configs runs half the
// package and reports green — both read exactly like a passing suite.
//
// The inventory is derived from the root config (the same parser CI's
// shared-layer step uses), so a new package or a new config is checked with
// no edit here.
//
// The script must also run through a `projects` aggregate. vitest removes
// each project's scratch directory on close, but the instance a single,
// non-aggregate config runs as writes its transformed modules to a
// `<tmpdir>/<id>/ssr` it never removes, so every green run of such a script
// leaves 3-80 MB behind in TMPDIR.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

// A computed specifier, which the lazy-import scan recognises as the
// by-path loader it is: `tools/checks` is dependency-free plain `.mjs`, and a
// relative import would leave this workspace.
const { readVitestProjects } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/vitest-projects.mjs')).href
)) as {
  readVitestProjects: (repoRoot: string) => { configPath: string; name: string | undefined }[]
}

interface WebRun {
  label: string
  args: string[]
}

interface Omission {
  /** Registered config paths the package's `test` script deliberately does not run. */
  configs: readonly string[]
  reason: string
}

/**
 * A workspace whose `test` script is a wrapper rather than vitest invocations,
 * and the configs it deliberately leaves out. Checked from both sides: every
 * omitted config must be registered AND must really be missing from the
 * script, so an entry cannot outlive the gap it explains.
 */
const LEDGER: Record<string, { wrapper: string; omits: Omission }> = {
  'apps/web': {
    // CI's test-jsdom job runs exactly this script; the browser projects run
    // in the browser job through `pnpm test:browser`, which needs Playwright.
    wrapper: 'scripts/run-web-tests.mjs',
    omits: {
      configs: [
        'apps/web/vitest.browser.config.ts',
        'apps/web/vitest.browser-window-state.config.ts',
      ],
      reason:
        'the wrapper is CI test-jsdom (jsdom + web-node); browser halves run via test:browser',
    },
  },
}

/** The vitest runs a ledgered wrapper makes, read from the wrapper itself. */
async function wrapperRuns(dir: string, wrapper: string): Promise<WebRun[]> {
  const module = (await import(pathToFileURL(join(REPO_ROOT, dir, wrapper)).href)) as {
    RUNS: WebRun[]
  }
  return module.RUNS
}

/** The value of `--config`/`-c` in an argv, or vitest's default config. */
function configOf(args: readonly string[]): string {
  const at = args.findIndex((arg) => arg === '--config' || arg === '-c')
  const inline = args.find((arg) => arg.startsWith('--config='))
  return (at >= 0 ? args[at + 1] : inline?.slice('--config='.length)) ?? 'vitest.config.ts'
}

/** Every `--project` value in an argv. */
function projectFilters(args: readonly string[]): string[] {
  return args.flatMap((arg, i) => {
    if (arg.startsWith('--project=')) return [arg.slice('--project='.length)]
    return arg === '--project' && args[i + 1] !== undefined ? [args[i + 1] as string] : []
  })
}

/** `projects: ['./a.config.ts', ...]` in a workspace-level aggregate config. */
function aggregateProjects(dir: string, configFile: string): string[] | undefined {
  const path = join(REPO_ROOT, dir, configFile)
  if (!existsSync(path)) return undefined
  const body = readFileSync(path, 'utf-8').match(/projects:\s*\[([^\]]*)\]/)?.[1]
  if (body === undefined) return undefined
  return [...body.matchAll(/'([^']+)'/g)].map((m) => join(dir, m[1] ?? '').replaceAll('\\', '/'))
}

/**
 * The config paths (repo-relative) one script's `vitest run` invocations load.
 * A bare `vitest run` loads the workspace's `vitest.config.ts`, which counts as
 * the configs its `projects` array lists when it is an aggregate.
 */
function configsRunByScript(dir: string, script: string): string[] {
  const out: string[] = []
  for (const command of script.split(/&&|;|\|\|/)) {
    if (!/\bvitest\s+run\b/.test(command)) continue
    const explicit = command.match(/--config[ =](\S+)/)?.[1]
    const file = explicit ?? 'vitest.config.ts'
    out.push(...(aggregateProjects(dir, file) ?? [join(dir, file).replaceAll('\\', '/')]))
  }
  return out
}

/**
 * Configs a plain `vitest run` script leaves out, with the reason. Both-sided
 * like the wrapper ledger: an entry must name a registered config the script
 * really does not run.
 */
const SCRIPT_OMITS: Record<string, Omission> = {}

const registered = new Map<string, string[]>()
const projectName = new Map<string, string | undefined>()
for (const { configPath, name } of readVitestProjects(REPO_ROOT)) {
  const dir = dirname(configPath)
  registered.set(dir, [...(registered.get(dir) ?? []), configPath])
  projectName.set(configPath, name)
}

/** The registered configs one wrapper run executes: its aggregate's projects, narrowed by `--project`. */
function configsRunByWrapperRun(dir: string, run: WebRun): string[] | undefined {
  const projects = aggregateProjects(dir, configOf(run.args))
  if (projects === undefined) return undefined
  const filters = projectFilters(run.args)
  if (filters.length === 0) return projects
  return projects.filter((config) => filters.includes(projectName.get(config) ?? ''))
}

function testScript(dir: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
  }
  return manifest.scripts?.test
}

describe('package test scripts run every registered project', () => {
  it('reads a non-trivial project inventory', () => {
    // A parser that found nothing would make every check below vacuous.
    expect(registered.size).toBeGreaterThan(15)
    expect([...registered.values()].flat().length).toBeGreaterThan(25)
  })

  it.each(
    [...registered.keys()].filter((dir) => !(dir in LEDGER)),
  )('%s has a test script naming every config it registers', (dir) => {
    const script = testScript(dir)
    expect(script, `${dir}/package.json has no "test" script`).toBeDefined()
    const ran = new Set(configsRunByScript(dir, script ?? ''))
    const omitted = SCRIPT_OMITS[dir]?.configs ?? []
    const missing = (registered.get(dir) ?? []).filter(
      (config) => !ran.has(config) && !omitted.includes(config),
    )
    expect(missing, `${dir}'s "test" script does not run: ${missing.join(', ')}`).toEqual([])
  })

  // `pnpm test <file>` appends the file to the LAST command of a chained
  // script only, so every earlier `vitest run` runs its whole config and the
  // last one exits 1 with "No test files found" whenever the file lives
  // elsewhere — a red exit after minutes of unrelated tests, with the named
  // test passing. One `vitest run` over an aggregate config (`projects: [...]`)
  // applies the filter to every project and fails only when nothing matches.
  it.each(
    [...registered.keys()].filter((dir) => !(dir in LEDGER)),
  )('%s runs its test script as one vitest process', (dir) => {
    const runs = (testScript(dir) ?? '').match(/\bvitest\s+run\b/g) ?? []
    expect(
      runs.length,
      `${dir}'s "test" script chains ${runs.length} vitest runs; use one over an aggregate vitest.config.ts`,
    ).toBeLessThanOrEqual(1)
  })

  it.each(
    [...registered.keys()].filter((dir) => !(dir in LEDGER)),
  )('%s runs its test script over a projects aggregate', (dir) => {
    const script = (testScript(dir) ?? '').trim()
    expect(
      script,
      `${dir}'s "test" script names a single config; a non-aggregate run leaves its scratch directory in TMPDIR — make it a bare \`vitest run\``,
    ).toBe('vitest run')
    expect(
      aggregateProjects(dir, 'vitest.config.ts'),
      `${dir}/vitest.config.ts is not a projects aggregate`,
    ).toBeDefined()
  })

  it.each(Object.entries(SCRIPT_OMITS))('ledgered omission in %s is still real', (dir, entry) => {
    const ran = configsRunByScript(dir, testScript(dir) ?? '')
    for (const config of entry.configs) {
      expect(registered.get(dir) ?? [], `${config} is not registered`).toContain(config)
      expect(ran, `${dir}'s "test" script now runs ${config}; drop the entry`).not.toContain(config)
    }
  })

  it.each(
    Object.entries(LEDGER),
  )('ledgered wrapper %s runs each half over an aggregate', async (dir, entry) => {
    const runs = await wrapperRuns(dir, entry.wrapper)
    expect(runs.length).toBeGreaterThan(1)
    for (const run of runs) {
      expect(
        configsRunByWrapperRun(dir, run),
        `${entry.wrapper}'s ${run.label} run loads ${configOf(run.args)}, which is not a projects aggregate`,
      ).toBeDefined()
      expect(configsRunByWrapperRun(dir, run), `${run.label} selects no project`).not.toEqual([])
    }
  })

  it.each(
    Object.entries(LEDGER),
  )('ledgered wrapper %s omits only what it records', async (dir, entry) => {
    const script = testScript(dir) ?? ''
    expect(script).toContain(entry.wrapper)
    const runs = await wrapperRuns(dir, entry.wrapper)
    const ran = new Set(runs.flatMap((run) => configsRunByWrapperRun(dir, run) ?? []))
    const configs = registered.get(dir) ?? []
    for (const omitted of entry.omits.configs) {
      expect(configs, `${omitted} is not registered`).toContain(omitted)
      expect(
        ran.has(omitted),
        `${entry.wrapper} now runs ${omitted}; drop it from the ledger`,
      ).toBe(false)
    }
    const missing = configs.filter((c) => !entry.omits.configs.includes(c) && !ran.has(c))
    expect(missing, `${entry.wrapper} does not run: ${missing.join(', ')}`).toEqual([])
  })
})

describe('configsRunByScript', () => {
  it('expands a bare run through an aggregate config', () => {
    expect(configsRunByScript('packages/mcp-server', 'vitest run')).toEqual([
      'packages/mcp-server/vitest.node.config.ts',
      'packages/mcp-server/vitest.smoke.config.ts',
    ])
  })

  it('reads each --config of a chained script', () => {
    expect(
      configsRunByScript(
        'packages/x',
        'vitest run --config vitest.node.config.ts && vitest run --config=vitest.browser.config.ts',
      ),
    ).toEqual(['packages/x/vitest.node.config.ts', 'packages/x/vitest.browser.config.ts'])
  })

  it('ignores commands that are not vitest runs', () => {
    expect(configsRunByScript('packages/x', 'tsc --noEmit')).toEqual([])
  })
})
