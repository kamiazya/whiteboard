// Machine-checked coverage map: proves that every correctness project removed
// from the publish gate (mcp-node, apps/web jsdom, web-browser) is still
// exercised by verify CI on the same commit. This is what makes it safe
// for publish-mcp to stop re-running `pnpm test` — a future edit that drops a
// project from ci.yml's verify path fails this test red.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

interface VitestProject {
  configPath: string
  name: string | undefined
  isBrowser: boolean
}

interface ElsewhereEntry {
  job: string
  mechanism: 'flag' | 'filter-script'
  marker: string
}

// vitest-projects.mjs (tools/checks) is the single source of truth for the
// project inventory AND the exclusion set (PROJECTS_RUN_ELSEWHERE) — this
// test and run-shared-layer-tests.mjs (the CI-invoked derivation) both import
// it rather than each holding their own copy, which is exactly the drift
// this task exists to remove. Dynamic import + cast matches the established
// pattern in release-gate-matrix.test.ts / verify-pack-contents.test.ts.
const VITEST_PROJECTS_MODULE_PATH = join(ROOT, 'tools/checks/src/vitest-projects.mjs')
const {
  readBrowserProjectNames,
  readVitestProjects,
  PROJECTS_RUN_ELSEWHERE,
  deriveSharedLayerProjectNames,
} = (await import(pathToFileURL(VITEST_PROJECTS_MODULE_PATH).href)) as {
  readBrowserProjectNames: (repoRoot: string) => string[]
  readVitestProjects: (repoRoot: string) => VitestProject[]
  PROJECTS_RUN_ELSEWHERE: Record<string, ElsewhereEntry>
  deriveSharedLayerProjectNames: (repoRoot: string) => string[]
}

function readCiWorkflow(): string {
  return readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8')
}

// Full-line comments stripped so a flag that was commented out (e.g.
// `# --project=facet-engine-node`) cannot be counted as coverage.
function readCiWorkflowWithoutComments(): string {
  return readCiWorkflow()
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

function readTestBrowserScript(): string {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
  }
  const script = packageJson.scripts?.['test:browser']
  expect(script, 'root package.json must declare a test:browser script').toBeDefined()
  return script!
}

describe('ci.yml verify coverage of removed publish-gate correctness projects', () => {
  const text = readCiWorkflow()

  it('runs the mcp-node project (test-unit job)', () => {
    expect(text).toMatch(/--project[=\s]mcp-node/)
  })

  it('runs the apps/web jsdom suite (test-jsdom job)', () => {
    expect(text).toContain('whiteboard-web test')
  })

  it('runs the root test:browser script (test-browser job), not a hand-listed subset', () => {
    // Hand-listing per-package vitest steps let canvas-render-browser drift
    // out of CI silently while package.json's test:browser script (the
    // documented local command) still listed it. Invoking the root script
    // instead ties CI to the same single list developers already run.
    expect(text).toMatch(/pnpm (run )?test:browser\b/)
  })

  it('the test:browser script covers every browser-enabled vitest project', () => {
    const script = readTestBrowserScript()
    const flaggedProjects = [...script.matchAll(/--project[=\s]([^\s]+)/g)].map((m) => m[1])
    const browserProjectNames = readBrowserProjectNames(ROOT)
    expect(browserProjectNames.length).toBeGreaterThan(0)
    expect(flaggedProjects).toEqual(expect.arrayContaining(browserProjectNames))
  })

  it('the verify job gates on all four test jobs, so a release tag always points at a commit where they ran', () => {
    const verifyIdx = text.indexOf('\n  verify:')
    expect(verifyIdx, 'verify job must exist').toBeGreaterThanOrEqual(0)
    const verifySection = text.slice(verifyIdx, verifyIdx + 400)
    const needsMatch = verifySection.match(/needs:\s*\[([^\]]+)\]/)
    expect(needsMatch, 'verify job must declare needs: [...]').not.toBeNull()
    const needs = needsMatch![1].split(',').map((s) => s.trim())
    expect(needs).toEqual(
      expect.arrayContaining(['check', 'test-unit', 'test-jsdom', 'test-browser']),
    )
  })

  // Which browser CI runs is not a detail: local runs use Playwright's Chromium
  // and CI pins the runner's system Chrome, so the browser is a variable
  // whenever a browser test passes in one place and fails in the other. The
  // setup doc claimed the opposite for a while, which is the worst version of
  // this — a contributor matching their machine to the doc diverges from CI.
  it('the setup doc names the system-Chrome pin CI actually uses', () => {
    const chromePin = text.match(/WHITEBOARD_CHROME_PATH:\s*(\S+)/)
    expect(chromePin, 'ci.yml must pin a browser for the browser jobs').not.toBeNull()
    const doc = readFileSync(join(ROOT, 'docs/contributing/development.md'), 'utf-8')
    expect(doc).toContain(chromePin![1])
    expect(doc).not.toContain('CI and the release workflow assume Playwright-managed Chromium')
  })
})

// The analogue of the describe block above, but for the node-mode side: a
// whole vitest project registered in root vitest.config.ts and never run by
// any CI step goes red on main with nothing noticing (facet-engine-node ran
// on nobody's CI for days before this guard existed). Unlike the old
// literal-flag check, this now tests the DERIVATION (deriveSharedLayerProjectNames)
// rather than ci.yml text: the shared-layer step's project list is no longer
// hand-listed in the workflow file, so "appears as --project=<name>" is no
// longer a meaningful assertion for those projects. Coverage is modelled by
// MECHANISM instead: a project is covered iff it is (a) picked up by the
// derivation and ci.yml invokes the derivation script in a test-unit step, or
// (b) exempted with mechanism 'flag' and ci.yml contains that literal flag, or
// (c) exempted with mechanism 'filter-script' and ci.yml contains that marker.
describe('ci.yml runs every node vitest project registered in root vitest.config.ts', () => {
  const projectConfigs = readVitestProjects(ROOT)

  it('derives a non-empty project list containing known anchors (not a vacuous scan)', () => {
    expect(projectConfigs.length).toBeGreaterThan(0)
    const names = projectConfigs.map((p) => p.name)
    expect(names).toEqual(expect.arrayContaining(['mcp-node', 'model-node', 'facet-engine-node']))
  })

  it('agrees with readBrowserProjectNames on which projects are browser-mode', () => {
    const derivedBrowserNames = projectConfigs
      .filter((p) => p.isBrowser)
      .map((p) => {
        if (!p.name) {
          throw new Error(`${p.configPath} enables browser mode but declares no test.name`)
        }
        return p.name
      })
      .sort()
    expect(derivedBrowserNames).toEqual([...readBrowserProjectNames(ROOT)].sort())
  })

  it('every PROJECTS_RUN_ELSEWHERE exemption still names a real, non-browser root-config path', () => {
    // Guards the allowlist from the other side: an exemption that outlives
    // the project it names (renamed away, or removed from vitest.config.ts),
    // or one that names a browser-mode project, must fail loudly rather than
    // sit as silent dead config or smuggle a browser project into the
    // node-only guard.
    const byPath = new Map(projectConfigs.map((p) => [p.configPath, p]))
    for (const [exemptedPath, entry] of Object.entries(PROJECTS_RUN_ELSEWHERE)) {
      const project = byPath.get(exemptedPath)
      expect(
        project,
        `${exemptedPath} is exempted in PROJECTS_RUN_ELSEWHERE but is not registered in root vitest.config.ts`,
      ).toBeDefined()
      expect(
        project!.isBrowser,
        `${exemptedPath} is exempted in PROJECTS_RUN_ELSEWHERE (job ${entry.job}) but is a browser-mode project`,
      ).toBe(false)
    }
  })

  it('the derivation and PROJECTS_RUN_ELSEWHERE partition the non-browser projects (no gap, no overlap)', () => {
    const nonBrowserNames = projectConfigs
      .filter((p) => !p.isBrowser)
      .map((p) => {
        if (!p.name) {
          throw new Error(`${p.configPath} declares no test.name`)
        }
        return p.name
      })
      .sort()
    const exemptedNames = projectConfigs
      .filter((p) => p.configPath in PROJECTS_RUN_ELSEWHERE)
      .map((p) => p.name!)
    const derivedNames = deriveSharedLayerProjectNames(ROOT)

    // No overlap: a project the exclusion set names must not also appear in
    // the derivation (it would otherwise run twice — once here, once in its
    // own CI step).
    const overlap = derivedNames.filter((name) => exemptedNames.includes(name))
    expect(
      overlap,
      `project(s) both derived AND exempted (would run twice): ${overlap.join(', ')}`,
    ).toEqual([])

    // No gap: their union must be exactly every non-browser project.
    expect([...derivedNames, ...exemptedNames].sort()).toEqual(nonBrowserNames)
  })

  it('ci.yml invokes the derivation script in a test-unit step', () => {
    const text = readCiWorkflow()
    expect(text).toMatch(/run:\s*node tools\/checks\/src\/run-shared-layer-tests\.mjs/)
  })

  it('every PROJECTS_RUN_ELSEWHERE exemption is actually covered in ci.yml by its declared mechanism', () => {
    const withoutComments = readCiWorkflowWithoutComments()

    const missing: string[] = []
    for (const [configPath, entry] of Object.entries(PROJECTS_RUN_ELSEWHERE)) {
      switch (entry.mechanism) {
        case 'flag': {
          const flagPattern = new RegExp(
            `--project[=\\s]${entry.marker.replace(/^--project=/, '')}(?![\\w-])`,
          )
          if (!flagPattern.test(withoutComments)) missing.push(configPath)
          break
        }
        case 'filter-script': {
          if (!withoutComments.includes(entry.marker)) missing.push(configPath)
          break
        }
        default: {
          // Exhaustive switch: an unknown mechanism value must fail loudly
          // rather than silently count as covered.
          throw new Error(`${configPath} has an unknown mechanism: ${String(entry.mechanism)}`)
        }
      }
    }

    expect(
      missing,
      `PROJECTS_RUN_ELSEWHERE entries not actually covered by their declared mechanism in ci.yml: ${missing.join(', ')}`,
    ).toEqual([])
  })

  // The two checks above only see what PROJECTS_RUN_ELSEWHERE currently
  // records — dropping an entry (accidentally or otherwise) makes its
  // project derived without making the OTHER, still-real ci.yml step that
  // covers it disappear, so the two checks above both stay green while the
  // project silently starts running twice. These two catch that from ci.yml's
  // actual, unconditional text instead of from the map's bookkeeping.
  it('no derived project is also named by a literal --project=<name> flag elsewhere in ci.yml (would run twice)', () => {
    const withoutComments = readCiWorkflowWithoutComments()
    // run-shared-layer-tests.mjs's own step has no --project= literal (its
    // names are computed at run time), so every match found here comes from
    // some OTHER job's dedicated step.
    const flaggedElsewhere = new Set(
      [...withoutComments.matchAll(/--project[=\s]([^\s]+)/g)].map((m) => m[1]),
    )
    const derivedNames = deriveSharedLayerProjectNames(ROOT)
    const doubleRun = derivedNames.filter((name) => flaggedElsewhere.has(name))
    expect(
      doubleRun,
      `project(s) both derived AND named by a --project flag elsewhere in ci.yml (would run twice): ${doubleRun.join(', ')}`,
    ).toEqual([])
  })

  it('no derived project lives under apps/web/, which always has its own dedicated test-jsdom job (would run twice)', () => {
    const ciText = readCiWorkflow()
    // This job step is unconditional YAML text, not generated from
    // PROJECTS_RUN_ELSEWHERE — it runs regardless of what the map records, so
    // any apps/web project reaching the derived list would run a second time
    // here even after being (correctly or mistakenly) dropped from the map.
    expect(ciText, 'ci.yml must run the apps/web jsdom+node suite via its own job').toContain(
      'whiteboard-web test',
    )
    const derivedNames = deriveSharedLayerProjectNames(ROOT)
    const doubleRun = projectConfigs
      .filter((p) => derivedNames.includes(p.name ?? '') && p.configPath.startsWith('apps/web/'))
      .map((p) => p.configPath)
    expect(
      doubleRun,
      `apps/web project(s) reached the derived list but apps/web already has its own dedicated CI job: ${doubleRun.join(', ')}`,
    ).toEqual([])
  })
})
