// Machine-checked coverage map: proves that every correctness project removed
// from the publish gate (mcp-node, apps/web jsdom, web-browser) is still
// exercised by verify CI on the same commit. This is what makes it safe
// for publish-mcp to stop re-running `pnpm test` — a future edit that drops a
// project from ci.yml's verify path fails this test red.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../../../..')

function readCiWorkflow(): string {
  return readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf-8')
}

// Same derivation docs-contract.test.ts uses for its "documents every
// real-browser vitest project" assertion: walk the projects root
// vitest.config.ts wires up and keep the ones with browser.enabled: true.
// Two independent guards deriving from the same ground truth is what makes
// ci.yml, package.json, and the docs enumeration unable to disagree silently
// — a project missing from any one of the three fails its own guard.
function readBrowserProjectNames(): string[] {
  const rootVitestConfig = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')
  const projectConfigPaths = [...rootVitestConfig.matchAll(/'((?:packages|apps)\/[^']+)'/g)].map(
    (match) => match[1],
  )
  return projectConfigPaths.flatMap((relativePath) => {
    const configContent = readFileSync(join(ROOT, relativePath), 'utf8')
    if (!/browser:\s*\{\s*\n?\s*enabled:\s*true/.test(configContent)) return []
    const nameMatch = configContent.match(/name:\s*'([^']+)'/)
    return nameMatch ? [nameMatch[1]] : []
  })
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
    const browserProjectNames = readBrowserProjectNames()
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
})
