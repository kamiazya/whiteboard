import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Static release-gate contract. Failing here means a release-sensitive
// surface (CODEOWNERS, package.json bin map, build chmod, prepublish
// gate) drifted out of sync with the documented release flow. The
// runtime artifact check (shebang / executable bit) lives in
// scripts/release/check-release-artifacts.mjs and is invoked by `pnpm
// check:release-artifacts` + `prepublishOnly`.

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname → packages/mcp-server/src/server/release
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..')
const PACKAGE_ROOT = resolve(__dirname, '..', '..', '..')
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
    '/packages/mcp-server/src/server/routes/ws-auth.ts',
    '/packages/mcp-server/src/shared/diagnostics/**',
    '/packages/mcp-server/src/shared/api-contracts/problem-details.ts',
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
