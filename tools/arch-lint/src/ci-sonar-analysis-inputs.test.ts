// The SonarQube analysis is report-only and costs ~28 minutes, so a pull
// request that cannot change its numbers skips the expensive steps. The skip
// is derived from sonar-project.properties (what Sonar is told not to analyse)
// rather than listed, and fails open: an unclassifiable path means "run".
//
// What this keeps true: the derivation reads the real exclusions, a docs-only
// diff skips, a source diff never does, the default branch is never skipped,
// and every costly step of the job sits behind the detect step — a gate on
// the scan alone would still pay the coverage run.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const { propertyList, sonarGlob, affectsSonarAnalysis } = (await import(
  pathToFileURL(join(REPO_ROOT, 'tools/checks/src/sonar-analysis-inputs.mjs')).href
)) as {
  propertyList: (text: string, key: string) => string[]
  sonarGlob: (pattern: string) => RegExp
  affectsSonarAnalysis: (changed: string[], exclusions: string[]) => boolean
}

const properties = readFileSync(join(REPO_ROOT, 'sonar-project.properties'), 'utf-8')
const exclusions = propertyList(properties, 'sonar.exclusions')
const workflow = readFileSync(join(REPO_ROOT, '.github/workflows/sonarqube.yml'), 'utf-8')

describe('sonar-analysis-inputs', () => {
  it('reads the real exclusion list, continuation lines included', () => {
    expect(exclusions.length).toBeGreaterThan(5)
    expect(exclusions).toContain('docs/**')
    expect(exclusions).toContain('**/node_modules/**')
  })

  it('skips a diff that only touches what Sonar does not analyse', () => {
    expect(
      affectsSonarAnalysis(['docs/contributing/testing.md', 'docs/assets/a.png'], exclusions),
    ).toBe(false)
    expect(affectsSonarAnalysis(['README.md', 'packages/x/CHANGELOG.md'], exclusions)).toBe(false)
    expect(
      affectsSonarAnalysis(['packages/a/dist/x.js', 'apps/web/public/y.svg'], exclusions),
    ).toBe(false)
  })

  it('runs for a source, test, config or workflow change, alone or beside docs', () => {
    for (const path of [
      'packages/model/src/a.ts',
      'packages/model/src/a.test.ts',
      'vitest.config.ts',
      'sonar-project.properties',
      '.github/workflows/sonarqube.yml',
      '.claude/scripts/x.mjs',
      'pnpm-lock.yaml',
    ]) {
      expect(affectsSonarAnalysis([path], exclusions), path).toBe(true)
      expect(affectsSonarAnalysis(['docs/a.md', path], exclusions), path).toBe(true)
    }
  })

  it('treats an empty diff as skippable and an unknown shape as material', () => {
    expect(affectsSonarAnalysis([], exclusions)).toBe(false)
    expect(affectsSonarAnalysis(['Makefile'], exclusions)).toBe(true)
  })

  it('matches `**` across directories and `*` within one', () => {
    expect(sonarGlob('docs/**').test('docs/a/b/c.png')).toBe(true)
    expect(sonarGlob('**/*.d.ts').test('packages/a/src/x.d.ts')).toBe(true)
    expect(sonarGlob('**/*.d.ts').test('x.d.ts')).toBe(true)
    expect(sonarGlob('*.md').test('a/b.md')).toBe(false)
  })
})

describe('sonarqube.yml', () => {
  const lines = workflow.replace(/^\s*#.*$/gm, '').split('\n')

  it('keeps 1.5x headroom over the newest measured run (~1680s), not 30 minutes', () => {
    const minutes = Number(/timeout-minutes: (\d+)/.exec(workflow)?.[1])
    expect(minutes).toBeGreaterThanOrEqual(45)
  })

  it('never skips the default branch', () => {
    expect(workflow).toContain("github.event_name == 'pull_request' && 'HEAD^1' || 'always'")
  })

  it('puts every costly step behind the detect step', () => {
    const gated = (needle: string): boolean => {
      const at = lines.findIndex((line) => line.includes(needle))
      expect(at, `${needle} not found`).toBeGreaterThan(-1)
      // A step runs from its `- ` marker to the next one.
      let first = at
      while (first > 0 && !/^\s{6}- /.test(lines[first] ?? '')) first -= 1
      let last = at + 1
      while (last < lines.length && !/^\s{6}- /.test(lines[last] ?? '')) last += 1
      return lines.slice(first, last).join('\n').includes("steps.detect.outputs.analyze == 'true'")
    }
    for (const needle of [
      './.github/actions/setup-pnpm',
      'pnpm install --frozen-lockfile',
      'pnpm coverage',
      'sonarqube-scan-action',
    ]) {
      expect(gated(needle), `${needle} runs on a diff that cannot change the analysis`).toBe(true)
    }
  })
})
