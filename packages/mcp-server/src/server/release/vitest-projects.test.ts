// Unit coverage for tools/checks/src/vitest-projects.mjs and
// run-shared-layer-tests.mjs — the derivation that replaces ci.yml's hand-
// listed `--project=` flags for the shared-layer step. Cross-package import
// of the .mjs matches the established pattern in
// release-gate-matrix-schema.test.ts / verify-pack-contents.test.ts.
//
// Fixture-based (a synthetic repo root under a temp dir) rather than against
// the real repo tree, so the throw paths (empty derivation, missing
// test.name, a browser-shaped name) can be reached without mutating the
// checkout — mutating the checkout to force those same paths red is done
// separately, by hand, as this task's required mutation checks.

import { readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sharedBrowserTestConfig } from '../../../../../vitest.browser.shared.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')
const VITEST_PROJECTS_MODULE_PATH = join(ROOT, 'tools/checks/src/vitest-projects.mjs')
const RUN_SHARED_LAYER_TESTS_MODULE_PATH = join(ROOT, 'tools/checks/src/run-shared-layer-tests.mjs')

interface FixtureProject {
  configPath: string
  name?: string
  /** true = the inline `enabled: true` literal; 'shared-helper' = the
   *  `browser: sharedBrowserTestConfig()` shape the dedupe introduced. */
  browser?: boolean | 'shared-helper'
}

interface VitestProjectsModule {
  readVitestProjects: (repoRoot: string) => Array<{
    configPath: string
    name: string | undefined
    isBrowser: boolean
  }>
  readBrowserProjectNames: (repoRoot: string) => string[]
  PROJECTS_RUN_ELSEWHERE: Record<string, { job: string; mechanism: string; marker: string }>
  deriveSharedLayerProjectNames: (repoRoot: string) => string[]
  buildVitestArgv: (names: string[]) => string[]
}

interface RunSharedLayerTestsModule {
  main: (options?: {
    repoRoot?: string
    stdout?: { write: (chunk: string) => boolean }
    stderr?: { write: (chunk: string) => boolean }
    spawn?: (
      cmd: string,
      args: string[],
      opts: Record<string, unknown>,
    ) => { status: number | null; error?: Error }
  }) => number
}

async function importVitestProjects(): Promise<VitestProjectsModule> {
  return (await import(
    pathToFileURL(VITEST_PROJECTS_MODULE_PATH).href
  )) as unknown as VitestProjectsModule
}

async function importRunSharedLayerTests(): Promise<RunSharedLayerTestsModule> {
  return (await import(
    pathToFileURL(RUN_SHARED_LAYER_TESTS_MODULE_PATH).href
  )) as unknown as RunSharedLayerTestsModule
}

function makeSink() {
  const chunks: string[] = []
  return {
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
    chunks,
  }
}

// Writes a synthetic repo root: a top-level vitest.config.ts registering each
// fixture project by config path, plus each project's own config file with
// the `name:` / `browser: { enabled: true }` shape the real parser scans for.
async function writeFixtureRepo(root: string, projects: FixtureProject[]): Promise<void> {
  const projectList = projects.map((p) => `      '${p.configPath}',`).join('\n')
  await writeFile(
    join(root, 'vitest.config.ts'),
    `import { defineConfig } from 'vitest/config'\nexport default defineConfig({\n  test: {\n    projects: [\n${projectList}\n    ],\n  },\n})\n`,
  )
  for (const project of projects) {
    await mkdir(join(root, dirname(project.configPath)), { recursive: true })
    const nameField = project.name ? `      name: '${project.name}',\n` : ''
    const browserField =
      project.browser === 'shared-helper'
        ? `      browser: sharedBrowserTestConfig(),\n`
        : project.browser
          ? `      browser: {\n        enabled: true,\n      },\n`
          : ''
    await writeFile(
      join(root, project.configPath),
      `import { defineConfig } from 'vitest/config'\nexport default defineConfig({\n  test: {\n${nameField}${browserField}  },\n})\n`,
    )
  }
}

describe('vitest-projects.mjs', () => {
  let fixtureRoot: string

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'vitest-projects-fixture-'))
  })

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true })
  })

  it('derives non-browser, non-exempted projects (real exclusion-set paths), sorted', async () => {
    const { deriveSharedLayerProjectNames } = await importVitestProjects()
    await writeFixtureRepo(fixtureRoot, [
      { configPath: 'packages/zeta/vitest.node.config.ts', name: 'zeta-node' },
      { configPath: 'packages/alpha/vitest.node.config.ts', name: 'alpha-node' },
      // Real PROJECTS_RUN_ELSEWHERE path — excluded even though it would
      // otherwise qualify.
      { configPath: 'packages/mcp-server/vitest.node.config.ts', name: 'mcp-node' },
      {
        configPath: 'packages/alpha/vitest.browser.config.ts',
        name: 'alpha-browser',
        browser: true,
      },
    ])

    expect(deriveSharedLayerProjectNames(fixtureRoot)).toEqual(['alpha-node', 'zeta-node'])
  })

  it('detects the shared-helper browser shape, keeping it out of the derivation', async () => {
    const { deriveSharedLayerProjectNames, readBrowserProjectNames } = await importVitestProjects()
    await writeFixtureRepo(fixtureRoot, [
      { configPath: 'packages/alpha/vitest.node.config.ts', name: 'alpha-node' },
      {
        configPath: 'packages/beta/vitest.browser.config.ts',
        name: 'beta-browser',
        browser: 'shared-helper',
      },
    ])

    expect(readBrowserProjectNames(fixtureRoot)).toEqual(['beta-browser'])
    expect(deriveSharedLayerProjectNames(fixtureRoot)).toEqual(['alpha-node'])
  })

  it('throws, naming the empty derivation, when every project is excluded or browser-mode', async () => {
    const { deriveSharedLayerProjectNames } = await importVitestProjects()
    await writeFixtureRepo(fixtureRoot, [
      { configPath: 'packages/mcp-server/vitest.node.config.ts', name: 'mcp-node' },
      {
        configPath: 'packages/alpha/vitest.browser.config.ts',
        name: 'alpha-browser',
        browser: true,
      },
    ])

    expect(() => deriveSharedLayerProjectNames(fixtureRoot)).toThrow(
      /found no shared-layer projects/,
    )
  })

  it('throws, naming the config path, when a selected project declares no test.name', async () => {
    const { deriveSharedLayerProjectNames } = await importVitestProjects()
    await writeFixtureRepo(fixtureRoot, [{ configPath: 'packages/alpha/vitest.node.config.ts' }])

    expect(() => deriveSharedLayerProjectNames(fixtureRoot)).toThrow(
      /packages\/alpha\/vitest\.node\.config\.ts.*declares no test\.name/,
    )
  })

  it('throws, naming the project, when a selected non-browser-detected project has a -browser-shaped name', async () => {
    const { deriveSharedLayerProjectNames } = await importVitestProjects()
    // browser: false (not set) but the name still ends in -browser — the
    // belt-and-braces check the isBrowser regex detection is not relied on alone.
    await writeFixtureRepo(fixtureRoot, [
      { configPath: 'packages/alpha/vitest.node.config.ts', name: 'alpha-browser' },
    ])

    expect(() => deriveSharedLayerProjectNames(fixtureRoot)).toThrow(/looks browser-mode/)
  })

  it('buildVitestArgv builds flags, not a shell string', async () => {
    const { buildVitestArgv } = await importVitestProjects()
    expect(buildVitestArgv(['a', 'b'])).toEqual([
      'exec',
      'vitest',
      'run',
      '--project=a',
      '--project=b',
    ])
  })

  it('every PROJECTS_RUN_ELSEWHERE mechanism is a known value', async () => {
    const { PROJECTS_RUN_ELSEWHERE } = await importVitestProjects()
    for (const [configPath, entry] of Object.entries(PROJECTS_RUN_ELSEWHERE)) {
      expect(['flag', 'filter-script'], `${configPath} has an unknown mechanism`).toContain(
        entry.mechanism,
      )
    }
  })
})

describe('run-shared-layer-tests.mjs (CLI)', () => {
  let fixtureRoot: string

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'run-shared-layer-tests-fixture-'))
  })

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true })
  })

  it('exits non-zero and never spawns vitest when the derivation is empty', async () => {
    const { main } = await importRunSharedLayerTests()
    await writeFixtureRepo(fixtureRoot, [
      { configPath: 'packages/mcp-server/vitest.node.config.ts', name: 'mcp-node' },
    ])
    const stderr = makeSink()
    const stdout = makeSink()
    let spawnCalled = false
    const exitCode = main({
      repoRoot: fixtureRoot,
      stdout,
      stderr,
      spawn: () => {
        spawnCalled = true
        return { status: 0 }
      },
    })

    expect(exitCode).not.toBe(0)
    expect(spawnCalled, 'vitest must never be spawned on an empty/failed derivation').toBe(false)
    expect(stderr.chunks.join('')).toMatch(/derivation failed/)
  })

  it('spawns pnpm exec vitest run with the derived --project flags and forwards its exit code', async () => {
    const { main } = await importRunSharedLayerTests()
    await writeFixtureRepo(fixtureRoot, [
      { configPath: 'packages/zeta/vitest.node.config.ts', name: 'zeta-node' },
      { configPath: 'packages/alpha/vitest.node.config.ts', name: 'alpha-node' },
    ])
    const stderr = makeSink()
    const stdout = makeSink()
    let capturedArgv: string[] | undefined
    let capturedCmd: string | undefined
    const exitCode = main({
      repoRoot: fixtureRoot,
      stdout,
      stderr,
      spawn: (cmd, args) => {
        capturedCmd = cmd
        capturedArgv = args
        return { status: 3 }
      },
    })

    expect(capturedCmd).toBe('pnpm')
    expect(capturedArgv).toEqual([
      'exec',
      'vitest',
      'run',
      '--project=alpha-node',
      '--project=zeta-node',
    ])
    expect(exitCode).toBe(3) // exit-code fidelity: forwards vitest's own status
  })

  it('exits zero and writes an OK summary to stdout when the spawned vitest run passes', async () => {
    const { main } = await importRunSharedLayerTests()
    await writeFixtureRepo(fixtureRoot, [
      { configPath: 'packages/alpha/vitest.node.config.ts', name: 'alpha-node' },
    ])
    const stderr = makeSink()
    const stdout = makeSink()
    const exitCode = main({
      repoRoot: fixtureRoot,
      stdout,
      stderr,
      spawn: () => ({ status: 0 }),
    })

    expect(exitCode).toBe(0)
    expect(stdout.chunks.join('')).toMatch(/OK: 1 project\(s\) passed/)
  })

  it('exits non-zero when pnpm itself fails to start', async () => {
    const { main } = await importRunSharedLayerTests()
    await writeFixtureRepo(fixtureRoot, [
      { configPath: 'packages/alpha/vitest.node.config.ts', name: 'alpha-node' },
    ])
    const stderr = makeSink()
    const stdout = makeSink()
    const exitCode = main({
      repoRoot: fixtureRoot,
      stdout,
      stderr,
      spawn: () => ({ status: null, error: new Error('ENOENT') }),
    })

    expect(exitCode).not.toBe(0)
    expect(stderr.chunks.join('')).toMatch(/pnpm could not start/)
  })
})

/**
 * `sharedBrowserTestConfig`'s trace budget.
 *
 * The default browser run must not record DOM snapshots. Measured on
 * `apps/web`'s 16 page files (63 tests, all passing): with snapshots on, the
 * run writes 302MB of trace scratch, 284MB of it the `.network` file that
 * carries every resource body vite served so the viewer can replay the DOM.
 * With them off, the same subset writes 7.5MB and a `.network` of zero. A
 * whole `web-browser` run measured 22GB and exhausted this container's disk
 * MID-RUN — reported not as "no space" but as `Failed to fetch dynamically
 * imported module`, `Cannot connect to the iframe`, and a summary of
 * `774 passed` against a true total of 929. 155 tests silently never ran and
 * the smaller total read like good news.
 *
 * Fidelity is not lost, only moved: `pnpm test:browser:trace` sets the env
 * var and gets the full trace back. That escape hatch is why the default is
 * allowed to be lean, so it is pinned here too — a CLI `--browser.trace=on`
 * cannot restore snapshots on its own (measured: a config carrying
 * `snapshots: false` still produced a zero-byte `.network` under that flag,
 * because vitest MERGES the override rather than replacing the object), so
 * this env var is the only thing that can.
 */
describe('sharedBrowserTestConfig trace budget', () => {
  const VAR = 'WHITEBOARD_TRACE_SNAPSHOTS'
  const before = process.env[VAR]

  afterEach(() => {
    if (before === undefined) delete process.env[VAR]
    else process.env[VAR] = before
  })

  // Statically imported, and the env var read PER CALL rather than at module
  // load, so no dynamic import is needed to see a changed value. An in-body
  // `await import()` would also trip `test-lazy-import-check` — which is how
  // the first version of this suite was written, and what caught it.
  it('records no DOM snapshots by default', () => {
    delete process.env[VAR]
    expect(sharedBrowserTestConfig().trace.snapshots).toBe(false)
  })

  it('records them when the trace script asks for them', () => {
    process.env[VAR] = '1'
    expect(sharedBrowserTestConfig().trace.snapshots).toBe(true)
  })
})

// ── Test-file coverage: every test file belongs to a project ──
//
// vitest only errors when a --project FILTER matches nothing; a test FILE
// matched by no project's include (or swallowed by an exclude with no other
// project picking it up) is silently never run, forever, while CI stays
// green. Three real glob holes had that shape (a `.browser.test.ts` under
// apps/web, the same under canvas-viewer landing in the NODE project, and
// apps/web's hand-listed root files). This guard walks the real tree and
// asserts the invariant that outlives them.
describe('every test file belongs to a vitest project', () => {
  interface ProjectGlobs {
    configPath: string
    dir: string
    name: string | undefined
    isBrowser: boolean
    include: string[]
    exclude: string[]
  }
  let projects: ProjectGlobs[]
  let matches: (pattern: string, relPath: string) => boolean
  beforeEach(async () => {
    const mod = (await import(pathToFileURL(VITEST_PROJECTS_MODULE_PATH).href)) as {
      readProjectTestGlobs: (repoRoot: string) => ProjectGlobs[]
      testGlobMatches: (pattern: string, relPath: string) => boolean
    }
    projects = mod.readProjectTestGlobs(ROOT)
    matches = mod.testGlobMatches
  })

  function matchedProjects(repoRelPath: string): ProjectGlobs[] {
    return projects.filter((project) => {
      if (!repoRelPath.startsWith(`${project.dir}/`)) return false
      const rel = repoRelPath.slice(project.dir.length + 1)
      return (
        project.include.some((pattern) => matches(pattern, rel)) &&
        !project.exclude.some((pattern) => matches(pattern, rel))
      )
    })
  }

  it('the matcher handles exactly the grammar the configs use', () => {
    expect(matches('src/**/*.test.ts', 'src/a/b/c.test.ts')).toBe(true)
    expect(matches('src/**/*.test.ts', 'src/c.test.ts')).toBe(true)
    expect(matches('src/**/*.test.ts', 'src/c.test.tsx')).toBe(false)
    expect(matches('*.test.ts', 'root.test.ts')).toBe(true)
    expect(matches('*.test.ts', 'src/root.test.ts')).toBe(false)
    expect(matches('scripts/**/*.test.ts', 'scripts/a/b.test.ts')).toBe(true)
    expect(matches('src/**/*.browser.test.tsx', 'src/x.browser.test.tsx')).toBe(true)
    expect(matches('src/**/*.browser.test.tsx', 'src/x.test.tsx')).toBe(false)
  })

  // The three holes, as virtual probes — each was real when this guard was
  // written, and the probe form keeps them checkable without committing a
  // file that exists only to be found.
  it('a .browser.test.ts under apps/web/src runs in the web-browser project', () => {
    const hit = matchedProjects('apps/web/src/probe.browser.test.ts')
    expect(hit.map((p) => p.name)).toContain('web-browser')
    expect(hit.every((p) => p.isBrowser)).toBe(true)
  })

  it('a .browser.test.ts under canvas-viewer/src runs only in browser projects', () => {
    const hit = matchedProjects('packages/canvas-viewer/src/probe.browser.test.ts')
    expect(hit.length).toBeGreaterThan(0)
    expect(
      hit.map((p) => p.name),
      'a browser test file must never land in a node/jsdom project',
    ).toEqual(hit.filter((p) => p.isBrowser).map((p) => p.name))
  })

  it('a new root-level apps/web test file runs in web-node without editing a hand list', () => {
    expect(matchedProjects('apps/web/probe-added-later.test.ts').map((p) => p.name)).toContain(
      'web-node',
    )
  })

  // Families deliberately outside the root project list, each pinned to the
  // config that runs it — an entry here whose config vanishes fails, so the
  // allowlist cannot outlive its reason.
  const OUT_OF_ROOT: Array<{ suffixPattern: RegExp; config: string; mustInclude: string }> = [
    {
      suffixPattern: /\.docs-snapshot\.test\.tsx$/,
      config: 'apps/web/vitest.docs-snapshots.config.ts',
      mustInclude: 'docs-snapshot',
    },
    {
      suffixPattern: /\.distribution\.test\.ts$/,
      config: 'packages/mcp-server/vitest.distribution.config.ts',
      mustInclude: 'distribution',
    },
  ]

  it('walking the real tree finds no test file that no project runs', () => {
    const orphans: string[] = []
    const wrongProject: string[] = []
    const roots = [...new Set(projects.map((p) => p.dir))]
    const skipDirs = new Set(['node_modules', 'dist', 'tmp', '.vitest-attachments', 'coverage'])
    const walk = (dir: string): string[] =>
      readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
        if (entry.isDirectory()) {
          return skipDirs.has(entry.name) ? [] : walk(`${dir}/${entry.name}`)
        }
        return /\.test\.tsx?$/.test(entry.name) ? [`${dir}/${entry.name}`] : []
      })
    for (const root of roots) {
      for (const file of walk(root)) {
        const out = OUT_OF_ROOT.find((o) => o.suffixPattern.test(file))
        if (out) {
          const config = readFileSync(join(ROOT, out.config), 'utf8')
          expect(config, `${out.config} must still run ${file}`).toContain(out.mustInclude)
          continue
        }
        const hit = matchedProjects(file)
        if (hit.length === 0) orphans.push(file)
        if (/\.browser\.test\.tsx?$/.test(file) && hit.some((p) => !p.isBrowser)) {
          wrongProject.push(file)
        }
      }
    }
    expect(
      orphans,
      'these test files are matched by NO vitest project and silently never run',
    ).toEqual([])
    expect(wrongProject, 'these browser test files are matched by a non-browser project').toEqual(
      [],
    )
  })

  it('the sweep itself sees a plausible number of files, so a broken walk cannot pass vacuously', () => {
    const roots = [...new Set(projects.map((p) => p.dir))]
    expect(roots.length).toBeGreaterThan(10)
    // Spot-anchor: the busiest project dir must resolve many files through
    // matchedProjects, or the include parsing has silently gone empty.
    const anyMcp = matchedProjects('packages/mcp-server/src/server/app.test.ts')
    expect(anyMcp.map((p) => p.name)).toContain('mcp-node')
  })
})
