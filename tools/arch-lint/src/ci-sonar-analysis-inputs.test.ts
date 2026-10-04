// The SonarQube analysis is report-only and costs ~28 minutes, so a pull
// request that cannot change its numbers skips the expensive steps. The skip
// is derived from sonar-project.properties (what Sonar is told not to analyse)
// rather than listed, and fails open: an unclassifiable path means "run".
//
// What this keeps true: the derivation reads the real exclusions, a docs-only
// diff skips, a source diff never does, the default branch is never skipped,
// and every costly step of the job sits behind the detect step — a gate on
// the scan alone would still pay the coverage run.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const CLI = join(REPO_ROOT, 'tools/checks/src/sonar-analysis-inputs.mjs')

const { propertyList, sonarGlob, affectsSonarAnalysis } = (await import(
  pathToFileURL(CLI).href
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

// sonarqube.yml runs the file as a process and gates the analysis on what it
// prints, so the CLI is pinned the same way: in throwaway git repositories,
// with its own HOME so the user's git config and hooks stay out.
describe('sonar-analysis-inputs run as the workflow runs it', () => {
  const workDir = mkdtempSync(join(tmpdir(), 'sonar-analysis-inputs-'))
  afterAll(() => rmSync(workDir, { recursive: true, force: true }))
  const env = { PATH: process.env.PATH ?? '', HOME: workDir, GIT_CONFIG_NOSYSTEM: '1' }
  const git = (cwd: string, ...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8', env },
    )
  const put = (cwd: string, rel: string, text: string) => {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true })
    writeFileSync(join(cwd, rel), text)
  }

  let repoCount = 0
  /** `main` holds the base; the checked-out branch is one commit `edit` makes on it. */
  function repoWith(edit: (cwd: string) => void): string {
    repoCount += 1
    const cwd = join(workDir, `repo-${repoCount}`)
    mkdirSync(cwd)
    git(cwd, 'init', '-q', '-b', 'main')
    put(cwd, 'sonar-project.properties', 'sonar.exclusions=docs/**,\\\n  **/dist/**\n')
    put(cwd, 'src/a.ts', 'export const a = 1\n')
    put(cwd, 'docs/x.png', 'x')
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', 'base')
    git(cwd, 'checkout', '-q', '-b', 'change')
    edit(cwd)
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', 'change')
    return cwd
  }

  function answer(cwd: string, args: string[]) {
    const outputPath = join(cwd, '.github-output')
    rmSync(outputPath, { force: true })
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...env, GITHUB_OUTPUT: outputPath },
    })
    let output = ''
    try {
      output = readFileSync(outputPath, 'utf8')
    } catch {
      // No file means nothing was appended, which the assertions read as ''.
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, output }
  }

  const docsOnly = repoWith((cwd) => put(cwd, 'docs/x.png', 'changed'))

  it('skips a diff that touches only excluded paths, and records it for the job', () => {
    const r = answer(docsOnly, ['main'])
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('false\n')
    expect(r.output).toBe('analyze=false\n')
    expect(r.stderr).toBe(
      '[sonar-analysis-inputs] analyze=false (1 changed path(s) against 2 exclusion pattern(s))\n',
    )
  })

  it('runs for a source change', () => {
    const r = answer(
      repoWith((cwd) => put(cwd, 'src/a.ts', 'export const a = 2\n')),
      ['main'],
    )
    expect(r.stdout).toBe('true\n')
    expect(r.output).toBe('analyze=true\n')
  })

  it('runs without diffing when told the base is `always`', () => {
    const r = answer(docsOnly, ['always'])
    expect(r.stdout).toBe('true\n')
    expect(r.stderr).toBe('[sonar-analysis-inputs] analyze=true (no PR base to diff against)\n')
  })

  it('fails open, naming why, when no base is given', () => {
    const r = answer(docsOnly, [])
    expect(r.stdout).toBe('true\n')
    expect(r.stderr).toContain('failing open: missing <base-ref> argument')
  })

  it('fails open when sonar-project.properties declares no exclusions', () => {
    const r = answer(
      repoWith((cwd) => put(cwd, 'sonar-project.properties', 'sonar.projectKey=x\n')),
      ['main'],
    )
    expect(r.stdout).toBe('true\n')
    expect(r.stderr).toContain('sonar-project.properties has no sonar.exclusions')
  })

  it('prints nothing when imported rather than run', () => {
    const r = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(CLI).href)})`],
      { cwd: workDir, encoding: 'utf8', env },
    )
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toBe('')
  })
})
