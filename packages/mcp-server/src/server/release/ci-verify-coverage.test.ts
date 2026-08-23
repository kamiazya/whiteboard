// Machine-checked coverage map: proves that every correctness project removed
// from the publish gate (mcp-node, apps/web jsdom, web-browser) is still
// exercised by verify CI on the same commit. This is what makes it safe
// for publish-mcp to stop re-running `pnpm test` — a future edit that drops a
// project from ci.yml's verify path fails this test red.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readBrowserProjectNames } from '../../shared/test-utils/vitest-browser-projects.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

function readCiWorkflow(): string {
  return readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8')
}

function readTestBrowserScript(): string {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as {
    scripts?: Record<string, string>
  }
  const script = packageJson.scripts?.['test:browser']
  expect(script, 'root package.json must declare a test:browser script').toBeDefined()
  return script!
}

// Config paths whose vitest project is exercised by CI through a mechanism
// other than a `--project=<name>` flag, keyed by the CONFIG PATH (not the
// project name) so a later rename of the project's `test.name` cannot
// silently invalidate the exemption.
const RUN_WITHOUT_PROJECT_FLAG: Record<string, string> = {
  // test-jsdom job: `pnpm --filter @kamiazya/whiteboard-web test` is
  // `vitest run && vitest run --config vitest.node.config.ts` — it runs both
  // of these by config path, never by --project flag.
  'apps/web/vitest.config.ts': 'test-jsdom',
  'apps/web/vitest.node.config.ts': 'test-jsdom',
}

interface DerivedVitestProject {
  configPath: string
  name: string | undefined
  isBrowser: boolean
}

// Every vitest project root vitest.config.ts wires up, derived the same way
// readBrowserProjectNames does but over a path regex broad enough to include
// tools/ (readBrowserProjectNames's packages|apps regex would silently drop
// tools/arch-lint).
function deriveVitestProjects(): DerivedVitestProject[] {
  const rootConfig = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf-8')
  const configPaths = [...rootConfig.matchAll(/'([^']+\.config\.ts)'/g)].map((match) => match[1])
  return configPaths.map((configPath) => {
    const configContent = readFileSync(join(ROOT, configPath), 'utf-8')
    const nameMatch = configContent.match(/name:\s*'([^']+)'/)
    const isBrowser = /browser:\s*\{\s*\n?\s*enabled:\s*true/.test(configContent)
    return { configPath, name: nameMatch?.[1], isBrowser }
  })
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
// on nobody's CI for days before this guard existed). This asserts EVERY
// node project derived from the root config is covered by ci.yml, by
// whichever real mechanism covers it — a --project= flag, or an explicit,
// job-named exemption for the ones that run through a package.json filter
// script instead.
describe('ci.yml runs every node vitest project registered in root vitest.config.ts', () => {
  const projectConfigs = deriveVitestProjects()

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

  it('every RUN_WITHOUT_PROJECT_FLAG exemption still names a real root-config path', () => {
    // Guards the allowlist from the other side: an exemption that outlives
    // the project it names (renamed away, or removed from vitest.config.ts)
    // must fail loudly rather than sit as silent dead config.
    const knownPaths = new Set(projectConfigs.map((p) => p.configPath))
    for (const exemptedPath of Object.keys(RUN_WITHOUT_PROJECT_FLAG)) {
      expect(
        knownPaths.has(exemptedPath),
        `${exemptedPath} is exempted in RUN_WITHOUT_PROJECT_FLAG but is not registered in root vitest.config.ts`,
      ).toBe(true)
    }
  })

  it('every non-browser, non-exempted project appears as --project=<name> in a ci.yml step', () => {
    const ciText = readCiWorkflow()
    // Strip full-line comments so a flag that was commented out (e.g.
    // `# --project=facet-engine-node`) cannot be counted as coverage.
    const withoutComments = ciText
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')

    const nodeProjectsRequiringFlag = projectConfigs.filter(
      (p) => !p.isBrowser && !(p.configPath in RUN_WITHOUT_PROJECT_FLAG),
    )

    const missing: string[] = []
    for (const project of nodeProjectsRequiringFlag) {
      if (!project.name) {
        throw new Error(
          `${project.configPath} declares no test.name and is not exempted from --project coverage`,
        )
      }
      const flagPattern = new RegExp(`--project[=\\s]${project.name}(?![\\w-])`)
      if (!flagPattern.test(withoutComments)) missing.push(project.name)
    }

    expect(
      missing,
      `project(s) registered in vitest.config.ts but not run by any ci.yml step: ${missing.join(', ')}`,
    ).toEqual([])
  })
})
