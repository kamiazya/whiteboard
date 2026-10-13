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
for (const { configPath } of readVitestProjects(REPO_ROOT)) {
  const dir = dirname(configPath)
  registered.set(dir, [...(registered.get(dir) ?? []), configPath])
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

  it.each(Object.entries(SCRIPT_OMITS))('ledgered omission in %s is still real', (dir, entry) => {
    const ran = configsRunByScript(dir, testScript(dir) ?? '')
    for (const config of entry.configs) {
      expect(registered.get(dir) ?? [], `${config} is not registered`).toContain(config)
      expect(ran, `${dir}'s "test" script now runs ${config}; drop the entry`).not.toContain(config)
    }
  })

  it.each(
    Object.entries(LEDGER),
  )('ledgered wrapper %s omits only what it records', (dir, entry) => {
    const script = testScript(dir) ?? ''
    expect(script).toContain(entry.wrapper)
    const wrapperText = readFileSync(join(REPO_ROOT, dir, entry.wrapper), 'utf-8')
    const configs = registered.get(dir) ?? []
    for (const omitted of entry.omits.configs) {
      expect(configs, `${omitted} is not registered`).toContain(omitted)
      const base = omitted.slice(dir.length + 1)
      expect(
        wrapperText,
        `${entry.wrapper} now runs ${base}; drop it from the ledger`,
      ).not.toContain(base)
    }
    for (const config of configs.filter((c) => !entry.omits.configs.includes(c))) {
      const base = config.slice(dir.length + 1)
      // The wrapper's default config is the bare `vitest run`; any other must be named.
      if (base !== 'vitest.config.ts') {
        expect(wrapperText, `${entry.wrapper} does not run ${base}`).toContain(base)
      }
    }
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
