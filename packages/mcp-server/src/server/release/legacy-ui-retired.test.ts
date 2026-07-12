// R5 of the MCP-UI retirement (ADR 0001) deletes packages/mcp-server/src/app,
// its build pipeline, and the WHITEBOARD_LEGACY_UI escape hatch. This test
// makes "the legacy UI is fully gone" a CI-enforced invariant rather than a
// one-time manual grep: any future reintroduction of these strings outside
// the allowlisted historical references fails the build.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
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
])

const SCAN_ROOTS = ['packages', 'apps/*/src', 'scripts', '.github/workflows', 'docs'].flatMap(
  (pattern) => {
    if (!pattern.includes('*')) return [pattern]
    const [prefix, suffix] = pattern.split('/*')
    const base = resolve(REPO_ROOT, prefix)
    let entries: string[]
    try {
      entries = readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      return []
    }
    return entries.map((name) => `${prefix}/${name}${suffix}`)
  },
)

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
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.git')) {
      continue
    }
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectFiles(fullPath))
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'))
      if (SCANNABLE_EXTENSIONS.has(ext)) results.push(fullPath)
    }
  }
  return results
}

function collectPackageJsonFiles(): string[] {
  // package.json files at each workspace root, not the entire dependency tree.
  const candidates = ['package.json', 'packages/mcp-server/package.json', 'apps/web/package.json']
  return candidates
    .map((rel) => resolve(REPO_ROOT, rel))
    .filter((abs) => {
      try {
        return statSync(abs).isFile()
      } catch {
        return false
      }
    })
}

describe('legacy UI (src/app, dist/app, WHITEBOARD_LEGACY_UI) stays retired', () => {
  it('no non-allowlisted file mentions the retired legacy-UI strings', () => {
    const filesToScan = new Set<string>([
      ...SCAN_ROOTS.flatMap((rel) => collectFiles(resolve(REPO_ROOT, rel))),
      ...collectPackageJsonFiles(),
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
