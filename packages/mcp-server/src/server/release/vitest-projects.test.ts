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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
