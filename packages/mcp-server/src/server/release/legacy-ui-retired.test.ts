// R5 of the MCP-UI retirement (ADR 0001) deletes packages/mcp-server/src/app,
// its build pipeline, and the WHITEBOARD_LEGACY_UI escape hatch. This test
// makes "the legacy UI is fully gone" a CI-enforced invariant rather than a
// one-time manual grep: any future reintroduction of these strings outside
// the allowlisted historical references fails the build.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname → packages/mcp-server/src/server/release
const REPO_ROOT = resolve(__dirname, '../../../../..')

const FORBIDDEN_PATTERNS: RegExp[] = [/\bsrc\/app\b/, /\bdist\/app\b/, /WHITEBOARD_LEGACY_UI/]

// Paths (relative to REPO_ROOT) allowed to mention the retired strings —
// historical record only, never live behavior.
const ALLOWLISTED_FILES = new Set([
  'docs/contributing/adr/0001-apps-web-canonical-frontend.md',
  'CHANGELOG.md',
  'packages/mcp-server/CHANGELOG.md',
  // This sweep test's own source necessarily contains the forbidden strings
  // as literal pattern/allowlist text.
  'packages/mcp-server/src/server/release/legacy-ui-retired.test.ts',
  // Asserts the flag is NOT documented — the literal string is the thing
  // being searched for, not a live reference to the flag.
  'packages/mcp-server/src/server/docs-contract.test.ts',
  // Asserts the packed tarball contains ZERO dist/app/ entries — the
  // literal string is the regression guard itself, not a live reference.
  'packages/mcp-server/src/server/mcp/tarball.distribution-impl.ts',
  // Unit-tests the dist/app/ rejection branch of assertTarballFileList with
  // a synthetic entry list — same rationale as the impl file above.
  'packages/mcp-server/src/server/mcp/tarball.distribution.test.ts',
])

function listAppNames(): string[] {
  try {
    return readdirSync(resolve(REPO_ROOT, 'apps'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

const APP_NAMES = listAppNames()

// Directory trees swept recursively. apps/* is narrowed to src/ so local
// build/scratch output under an app root cannot make this sweep flaky.
const SCAN_ROOTS = [
  'packages',
  ...APP_NAMES.map((name) => `apps/${name}/src`),
  'scripts',
  '.github/workflows',
  'docs',
]

// Individual files outside the swept trees. Workspace-root manifests only —
// never the dependency tree. packages/**/package.json is already covered by
// the `packages` sweep.
const SCAN_FILES = ['package.json', ...APP_NAMES.map((name) => `apps/${name}/package.json`)]

const SCANNABLE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
])

function collectFiles(dir: string): string[] {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const results: string[] = []
  for (const entry of entries) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'tmp' ||
      entry.name.startsWith('.git')
    ) {
      continue
    }
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath))
    } else if (entry.isFile() && SCANNABLE_EXTENSIONS.has(extname(entry.name))) {
      results.push(fullPath)
    }
  }
  return results
}

describe('legacy UI (src/app, dist/app, WHITEBOARD_LEGACY_UI) stays retired', () => {
  it('no non-allowlisted file mentions the retired legacy-UI strings', () => {
    const filesToScan = new Set<string>([
      ...SCAN_ROOTS.flatMap((rel) => collectFiles(resolve(REPO_ROOT, rel))),
      ...SCAN_FILES.map((rel) => resolve(REPO_ROOT, rel)).filter((abs) => existsSync(abs)),
    ])

    const violations: string[] = []
    for (const absPath of filesToScan) {
      const relPath = relative(REPO_ROOT, absPath)
      if (ALLOWLISTED_FILES.has(relPath)) continue
      const content = readFileSync(absPath, 'utf-8')
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${relPath}: matches ${pattern}`)
        }
      }
    }

    expect(violations).toEqual([])
  })
})
