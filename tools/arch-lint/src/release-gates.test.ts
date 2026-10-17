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
    // The code that computes the required ci-gate check: a pull request can
    // change it, so it needs the owner's review on its own rule.
    '/.github/**',
    '/tools/checks/**',
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

// A forced publish checks out and builds the TAG, while every attestation the
// run makes — npm `--provenance`, the image's provenance, the cosign
// certificate — names GITHUB_SHA and the ref the dispatch ran from. Dispatched
// from main, a tag main never held would ship under main's identity, so every
// job that checks out `force_publish_tag` refuses a HEAD that is not
// GITHUB_SHA, or a GITHUB_REF that is not that exact tag, as the very next step: anything later already runs the tag's code
// (its `./.github/actions/*` included).
interface ReleaseStep {
  name?: string
  uses?: string
  if?: string
  run?: string
  with?: { ref?: string }
  env?: Record<string, string>
}
const RELEASE_JOBS = (
  parseYaml(readFileSync(resolve(REPO_ROOT, '.github/workflows/release.yml'), 'utf-8')) as {
    jobs: Record<string, { steps: ReleaseStep[] }>
  }
).jobs
const isCheckout = (s: ReleaseStep) => (s.uses ?? '').startsWith('actions/checkout@')
const FORCED_CHECKOUT_JOBS = Object.entries(RELEASE_JOBS)
  .filter(([, job]) =>
    job.steps.some((s) => isCheckout(s) && (s.with?.ref ?? '').includes('force_publish_tag')),
  )
  .map(([name, job]) => ({ name, steps: job.steps }))

const FORCED_TAG = 'mcp-server-v1.2.3'

describe('release gate: a forced publish attests the commit it publishes', () => {
  const tmpRoots: string[] = []
  afterAll(() => {
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
  })

  function runGuard(
    script: string,
    sha: (head: string) => string,
    ref = `refs/tags/${FORCED_TAG}`,
  ) {
    const cwd = mkdtempSync(join(tmpdir(), 'release-provenance-'))
    tmpRoots.push(cwd)
    // A git hook exports GIT_DIR and friends; inherited, they point every
    // command here at the repository being pushed instead of the scratch one.
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' }
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd, env, encoding: 'utf-8' }).stdout.trim()
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
    const res = spawnSync('bash', ['-e', '-c', script], {
      cwd,
      env: { ...env, GITHUB_SHA: sha(head), GITHUB_REF: ref, FORCE_PUBLISH_TAG: FORCED_TAG },
      encoding: 'utf-8',
    })
    return { status: res.status, stderr: `${res.stdout}${res.stderr}` }
  }

  it('finds both publishing jobs among those that check out the forced tag', () => {
    expect(FORCED_CHECKOUT_JOBS.map((j) => j.name)).toEqual(
      expect.arrayContaining(['publish-mcp', 'docker-publish-sign']),
    )
  })

  describe.each(FORCED_CHECKOUT_JOBS)('$name', ({ steps }) => {
    const checkoutIndex = steps.findIndex(isCheckout)
    const guard = steps[checkoutIndex + 1]
    const script = guard?.run ?? 'exit 99'

    it('checks HEAD against GITHUB_SHA as the step right after checkout', () => {
      expect(script).toMatch(/git rev-parse HEAD/)
      expect(script).toMatch(/GITHUB_SHA/)
      expect(guard?.if).toContain('inputs.force_publish_tag')
      expect(guard?.env?.FORCE_PUBLISH_TAG).toContain('inputs.force_publish_tag')
      expect(script).toMatch(/GITHUB_REF/)
    })

    // The certificate and provenance name the dispatched REF as well as the
    // commit: a dispatch from main at the tag's own commit passes the HEAD
    // check yet signs as release.yml@refs/heads/main.
    it('refuses a dispatch at the tagged commit that ran from another ref', () => {
      const res = runGuard(script, (head) => head, 'refs/heads/main')
      expect(res.status).not.toBe(0)
      expect(res.stderr).toContain('--ref')
    })

    it('refuses when the checked-out tag is not the dispatched commit, and says how to dispatch', () => {
      const res = runGuard(script, () => 'f'.repeat(40))
      expect(res.status).not.toBe(0)
      expect(res.stderr).toContain('--ref')
    })

    it('passes when the dispatch ran from the tag it publishes', () => {
      const res = runGuard(script, (head) => head)
      expect(res.status, res.stderr).toBe(0)
    })
  })
})
