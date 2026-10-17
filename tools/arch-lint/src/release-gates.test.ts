import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from './scan-roots.js'

// Static release-gate contract. Failing here means a release-sensitive
// surface (CODEOWNERS, package.json bin map, build chmod, prepublish
// gate) drifted out of sync with the documented release flow. The
// runtime artifact check (shebang / executable bit) lives in
// scripts/release/check-release-artifacts.mjs and is invoked by `pnpm
// check:release-artifacts` + `prepublishOnly`.

const PACKAGE_ROOT = resolve(REPO_ROOT, 'packages', 'mcp-server')
const PACKAGE_JSON_PATH = resolve(PACKAGE_ROOT, 'package.json')
const CODEOWNERS_PATH = resolve(REPO_ROOT, '.github', 'CODEOWNERS')

interface CodeownerLine {
  pattern: string
  owners: string[]
}

function parseCodeowners(text: string): CodeownerLine[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [pattern, ...owners] = line.split(/\s+/)
      return { pattern, owners }
    })
}

describe('release gate: CODEOWNERS', () => {
  // Path patterns that MUST be covered by an entry with at least one
  // owner token. The test does not require an exact-pattern match —
  // a broader parent pattern that prefix-covers the path also counts —
  // so a CODEOWNERS reorganisation is allowed as long as coverage
  // remains.
  const REQUIRED_PATH_PATTERNS = [
    // Catch-all + repo-level files
    '*',
    '/package.json',
    '/.github/CODEOWNERS',
    // Runtime / daemon lifecycle
    '/packages/mcp-server/src/server/**',
    '/packages/mcp-server/src/daemon/**',
    '/packages/mcp-server/src/cli/**',
    // Security-sensitive surface
    '/packages/mcp-server/src/server/security/**',
    '/packages/mcp-server/src/server/routes/runtime.ts',
    '/packages/mcp-server/src/server/routes/auth.ts',
    '/packages/mcp-server/src/shared/diagnostics/**',
    // Release / distribution
    '/packages/mcp-server/package.json',
    '/packages/mcp-server/scripts/**',
    '/tests/e2e/distribution/**',
  ]

  const text = readFileSync(CODEOWNERS_PATH, 'utf-8')
  const lines = parseCodeowners(text)

  it('CODEOWNERS file exists at .github/CODEOWNERS and parses non-empty', () => {
    expect(text.length).toBeGreaterThan(0)
    expect(lines.length).toBeGreaterThan(0)
  })

  it.each(REQUIRED_PATH_PATTERNS)('includes a line for %s with at least one owner', (pattern) => {
    const match = lines.find((l) => l.pattern === pattern)
    expect(match, `no CODEOWNERS line for "${pattern}"`).toBeDefined()
    expect(match!.owners.length).toBeGreaterThan(0)
    for (const owner of match!.owners) {
      // GitHub owner tokens start with `@` (user or team). An
      // owner-less line is invalid CODEOWNERS syntax and silently
      // disables review enforcement on that path.
      expect(owner).toMatch(/^@/)
    }
  })

  it('rejects any owner-less line — empty owners silently disable review enforcement', () => {
    for (const line of lines) {
      expect(
        line.owners.length,
        `CODEOWNERS line "${line.pattern}" has no owner tokens`,
      ).toBeGreaterThan(0)
    }
  })
})

describe('release gate: package.json bin + scripts contract', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as {
    bin?: Record<string, string>
    scripts?: Record<string, string>
  }

  it('bin map ships only `whiteboard` (the unified CLI entrypoint)', () => {
    expect(pkg.bin?.whiteboard).toBe('dist/cli/index.js')
    expect(Object.keys(pkg.bin ?? {})).toEqual(['whiteboard'])
  })

  it('build:server chmods the `whiteboard` bin so the published tarball is executable on POSIX', () => {
    const buildServer = pkg.scripts?.['build:server'] ?? ''
    expect(buildServer).toMatch(/chmod \+x[^&]*dist\/cli\/index\.js/)
  })

  it('prepublishOnly verifies the `whiteboard` bin is executable', () => {
    const prepublish = pkg.scripts?.prepublishOnly ?? ''
    expect(prepublish).toContain('test -x dist/cli/index.js')
  })
})

describe('release gate: a forced npm publish attests the commit it publishes', () => {
  // `npm publish --provenance` attests GITHUB_SHA — the commit the dispatch
  // ran from — while a forced publish checks out and packs the TAG. Dispatched
  // from main, the provenance would name a commit the tarball was not built
  // from, so the job must refuse before it publishes.
  interface Step {
    name?: string
    uses?: string
    if?: string
    run?: string
  }
  const release = parseYaml(
    readFileSync(resolve(REPO_ROOT, '.github/workflows/release.yml'), 'utf-8'),
  ) as {
    jobs: Record<string, { steps: Step[] }>
  }
  const steps = release.jobs['publish-mcp']?.steps ?? []
  const guardIndex = steps.findIndex(
    (s) => /git rev-parse HEAD/.test(s.run ?? '') && /GITHUB_SHA/.test(s.run ?? ''),
  )
  const checkoutIndex = steps.findIndex((s) => (s.uses ?? '').startsWith('actions/checkout@'))
  const publishIndex = steps.findIndex((s) => /npm publish[^\n]*--provenance/.test(s.run ?? ''))

  const tmpRoots: string[] = []
  afterAll(() => {
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
  })

  function runGuard(sha: (head: string) => string): { status: number | null; stderr: string } {
    const cwd = mkdtempSync(join(tmpdir(), 'release-provenance-'))
    tmpRoots.push(cwd)
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, encoding: 'utf-8' }).stdout.trim()
    git('init', '-q')
    git(
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'tag',
    )
    const head = git('rev-parse', 'HEAD')
    const res = spawnSync('bash', ['-e', '-c', steps[guardIndex]?.run ?? 'exit 99'], {
      cwd,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GITHUB_SHA: sha(head) },
      encoding: 'utf-8',
    })
    return { status: res.status, stderr: `${res.stdout}${res.stderr}` }
  }

  it('checks HEAD against GITHUB_SHA after checkout and before npm publish --provenance', () => {
    expect(checkoutIndex).toBeGreaterThanOrEqual(0)
    expect(publishIndex).toBeGreaterThan(checkoutIndex)
    expect(guardIndex).toBeGreaterThan(checkoutIndex)
    expect(guardIndex).toBeLessThan(publishIndex)
    expect(steps[guardIndex]?.if).toContain('inputs.force_publish_tag')
  })

  it('refuses when the checked-out tag is not the dispatched commit, and says how to dispatch', () => {
    const res = runGuard(() => 'f'.repeat(40))
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('--ref')
  })

  it('passes when the dispatch ran from the tag it publishes', () => {
    const res = runGuard((head) => head)
    expect(res.status, res.stderr).toBe(0)
  })
})
