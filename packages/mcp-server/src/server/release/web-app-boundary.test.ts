// Property catalog: hosted web app / npm package boundary invariants.
// Drift guards:
//   - apps/web's RELATIVE imports ('./...', '../...') must not resolve into
//     src/server, src/cli, src/daemon, or a Node-only builtin; a relative
//     src/shared import is restricted to an explicit allowlist
//     (forbiddenResolvedPath, isAllowedSharedImport)
//   - apps/web's BARE '@kamiazya/whiteboard-mcp/<subpath>' imports — the style
//     it actually uses for every shared/daemon-client module — are resolved
//     through packages/mcp-server/package.json's `exports` map back to their
//     src/ source file (resolveMcpSubpathEntry), and that file's transitive
//     closure of imports is walked with the SAME bans (collectTransitiveViolations).
//     The walk recurses through BOTH relative ('./...') imports AND a nested
//     bare '@kamiazya/whiteboard-mcp/<subpath>' re-import found mid-chain
//     (e.g. one allowlisted src/shared module re-importing another subpath by
//     its published specifier instead of a relative path) — only a bare
//     specifier for a genuinely different third-party package is out of scope.
//     A subpath absent from the exports map, or from the small
//     TEST_ONLY_SUBPATHS alias list mirroring apps/web/vitest.config.ts, is
//     itself a violation — nothing is silently skipped. forbiddenResolvedPath
//     alone is blind to this whole import style, since it bails out on any
//     specifier not starting with '.'.
//   - @kamiazya/whiteboard-mcp package.json files must not include apps/ or src/
//   - pnpm-workspace.yaml must declare apps/* so apps/web participates in workspace builds
//   - apps/web skeleton must exist at the intended deploy-target location
// No PBT: static file-list / import-list guards are clearer as example tests.
//
// The original daemon-served browser UI this test catalog once also scanned
// was deleted in Stage 5 of the MCP-UI retirement (ADR 0001); apps/web is
// the sole browser app now.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname → packages/mcp-server/src/server/release
const REPO_ROOT = resolve(__dirname, '../../../../..')
const PACKAGE_ROOT = resolve(__dirname, '../../..')
const PACKAGE_SRC_DIR = resolve(PACKAGE_ROOT, 'src')
const APPS_WEB_DIR = resolve(REPO_ROOT, 'apps/web')
const APPS_WEB_SRC_DIR = resolve(REPO_ROOT, 'apps/web/src')
// Synthetic fixture dir for the forbiddenResolvedPath unit tests below — kept
// outside any real browser app dir so those tests must pass browserAppDir
// explicitly rather than relying on collectBrowserAppFiles's real scan roots.
const FIXTURE_BROWSER_APP_DIR = resolve(PACKAGE_SRC_DIR, '__fixture-browser-app__')
// Bare-specifier prefix for the daemon package, and its real `exports` map
// (each subpath's `types` target points at ./src/*.ts) — shared by every
// subpath-boundary scan below.
const MCP_PACKAGE_SPECIFIER = '@kamiazya/whiteboard-mcp'
const MCP_EXPORTS_MAP = (
  JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
    exports: Record<string, { types?: string } | string>
  }
).exports

/**
 * Check whether a GitHub Actions job body declares `environment: production-web`,
 * either as the short string form or the `name:`/`url:` mapping form (in any key
 * order, quotes optional, with or without a trailing YAML comment).
 *
 * This walks lines instead of using a single combined regex. A prior version
 * used one alternation with a lazy-repeated inner group
 * (`(?:\s+[\w-]+:[^\n]*\r?\n)*?`) whose `\s+` could itself consume the
 * following `\r?\n`, giving the engine exponentially many ways to partition a
 * non-matching input and triggering catastrophic backtracking (CodeQL
 * js/redos). Scanning line-by-line makes each step O(1) with no backtracking.
 *
 * Comments are stripped before matching so a trailing `# ...` on either the
 * `environment:` line or a `name:` line inside the mapping form doesn't leak
 * into the compared value. The scalar form also returns immediately once a
 * non-empty inline value is present: a value that isn't `production-web`
 * (e.g. `environment: development`) must not fall through to scan the
 * mapping-form block below it, or a `name: production-web` line belonging to
 * an unrelated nested key could produce a false positive.
 */
function matchesEnvironmentProductionWeb(jobSection: string): boolean {
  const stripQuotes = (s: string) => s.trim().replace(/^['"]|['"]$/g, '')
  const lines = jobSection.split(/\r?\n/).map((line) => line.replace(/#.*$/, ''))
  const envIndex = lines.findIndex((line) => /^\s*environment:\s*/.test(line))
  if (envIndex === -1) return false

  const envLine = lines[envIndex]
  const inlineValue = envLine.match(/^\s*environment:\s*(.*)$/)?.[1]?.trim() ?? ''
  if (inlineValue !== '') return stripQuotes(inlineValue) === 'production-web'

  // Mapping form: `environment:` on its own line, followed by an indented
  // block of `key: value` entries (any order) until the block ends (a line
  // at or below the `environment:` line's own indentation, or a non-key line).
  const envIndent = envLine.match(/^(\s*)/)?.[1]?.length ?? 0
  for (let i = envIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0
    if (indent <= envIndent) break
    if (!/^\s+[\w-]+:/.test(line)) break
    const nameMatch = line.match(/^\s+name:\s*(.*)$/)
    if (nameMatch && stripQuotes(nameMatch[1]) === 'production-web') return true
  }
  return false
}

describe('matchesEnvironmentProductionWeb edge cases', () => {
  it('matches the inline scalar form with a trailing YAML comment', () => {
    expect(
      matchesEnvironmentProductionWeb(
        'deploy-web:\n    environment: production-web  # deploy target\n',
      ),
    ).toBe(true)
  })

  it('matches the mapping form with a trailing YAML comment on the name: line', () => {
    expect(
      matchesEnvironmentProductionWeb(
        'deploy-web:\n    environment:\n      name: production-web  # deploy target\n      url: https://example.com\n',
      ),
    ).toBe(true)
  })

  it('does not fall through to a later name: line when the inline scalar does not match', () => {
    expect(
      matchesEnvironmentProductionWeb(
        'deploy-web:\n    environment: development\n  name: production-web\n',
      ),
    ).toBe(false)
  })
})

function collectTsFiles(dir: string): string[] {
  const results: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectTsFiles(fullPath))
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      results.push(fullPath)
    }
  }
  return results
}

// Returns all browser app TypeScript files paired with their containing app root.
// The app root is used by forbiddenResolvedPath to distinguish internal from cross-boundary imports.
function collectBrowserAppFiles(): { file: string; browserAppDir: string }[] {
  if (!existsSync(APPS_WEB_SRC_DIR)) return []
  return collectTsFiles(APPS_WEB_SRC_DIR).map((file) => ({ file, browserAppDir: APPS_WEB_SRC_DIR }))
}

// Extracts all import/require specifiers, including side-effect imports and re-exports.
function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  // Named/default imports and all re-exports: `from 'specifier'`
  // Covers: import foo from '...', import { foo } from '...', export * from '...', export { foo } from '...'
  for (const m of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specifiers.push(m[1])
  // Side-effect imports: `import 'specifier'` (no bindings, no `from`)
  for (const m of source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specifiers.push(m[1])
  // Dynamic imports: import('specifier')
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1])
  // CommonJS require
  for (const m of source.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1])
  return [...new Set(specifiers)]
}

// ── Node-only builtin detection ───────────────────────────────────────────────

// All Node.js built-in module names (public, non-internal — internal modules start with '_').
// Using builtinModules covers crypto, stream, url, buffer, util, events, zlib, etc.
// that a hand-written list would easily miss.
const NODE_BUILTIN_NAMES = new Set(builtinModules.filter((m) => !m.startsWith('_')))

function isForbiddenNodeBuiltin(specifier: string): boolean {
  // Explicit node: protocol prefix covers all builtins unambiguously.
  if (specifier.startsWith('node:')) return true
  // For bare specifiers like 'fs', 'crypto', 'fs/promises', 'path/posix' —
  // strip sub-path and check the root module name against the full builtin list.
  const base = specifier.split('/')[0] ?? specifier
  return NODE_BUILTIN_NAMES.has(base)
}

// ── src/shared allowlist ──────────────────────────────────────────────────────

// Explicit allowlist of browser-safe surfaces within src/shared/ that the browser app may import.
// Any src/shared/* import NOT matching this list is a boundary violation.
// Add new entries here only after confirming the module contains no Node-only APIs.
const ALLOWED_SHARED_EXACT = new Set([
  'api-client.js', // fetch transport wrapper — DOM/global-only, no Node APIs
  'browser-tracing.js', // optional browser-side OpenTelemetry init — DOM/global-only, no Node APIs
  'document-backend-contract.js', // transport/callback seam — types + Zod re-exports only, no Node APIs
  'daemon-backend.js', // WebSocket + apiFetch transport for the canvas editor, no Node APIs
  'external-url-policy.js', // pure URL validation, no Node APIs
  'sse-stream-hub.js', // shared SSE stream + per-document refcounting, no Node APIs
  'sync-sse-contract.js', // SSE event Zod schemas, no Node APIs
  'token-store.js', // in-memory daemon-token holder, no Node APIs
  'upload-files.js', // file upload transport, no Node APIs
  'ws-messages.js', // WebSocket protocol types/constants
  'ws-protocol.js', // WebSocket protocol helpers
  'ws-text-message.js', // WebSocket text-message parsing, no Node APIs
])

// test-utils/* is intentionally excluded here — it is handled separately below
// and only allowed when fromFile is a test file.
const ALLOWED_SHARED_DIR_PREFIXES = [
  'api-contracts/', // Zod schemas and DTO types — browser-safe by design
]

function isTestFile(filePath: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(filePath)
}

function isAllowedSharedImport(relToShared: string, fromFile: string): boolean {
  if (ALLOWED_SHARED_EXACT.has(relToShared)) return true
  if (ALLOWED_SHARED_DIR_PREFIXES.some((prefix) => relToShared.startsWith(prefix))) return true
  // test-utils/* is browser-test infrastructure — forbidden in production source files
  // so fast-check helpers cannot accidentally enter the production browser bundle.
  if (relToShared.startsWith('test-utils/')) return isTestFile(fromFile)
  return false
}

// ── Cross-boundary path checker ───────────────────────────────────────────────

// Returns the path relative to src/ if the specifier resolves from fromFile into
// a forbidden zone; null if the import is within the browser app dir or explicitly allowed.
function forbiddenResolvedPath(
  fromFile: string,
  specifier: string,
  browserAppDir = APPS_WEB_SRC_DIR,
): string | null {
  if (!specifier.startsWith('.')) return null
  const resolved = resolve(dirname(fromFile), specifier)
  if (resolved.startsWith(`${browserAppDir}/`) || resolved === browserAppDir) return null
  const relToSrc = relative(PACKAGE_SRC_DIR, resolved)
  // Import is outside packages/mcp-server/src entirely — not a forbidden cross-import.
  if (relToSrc.startsWith('..')) return null
  // Server-side / CLI / daemon modules must never enter the browser bundle.
  if (
    relToSrc.startsWith('server/') ||
    relToSrc.startsWith('cli/') ||
    relToSrc.startsWith('daemon/')
  ) {
    return relToSrc
  }
  // Shared modules: only the explicit allowlist is browser-safe.
  // diagnostics, version helpers, Node-backed parsers, etc. are forbidden here.
  if (relToSrc.startsWith('shared/')) {
    const relToShared = relToSrc.slice('shared/'.length)
    if (!isAllowedSharedImport(relToShared, fromFile)) {
      return relToSrc
    }
  }
  return null
}

// ── Parser coverage (fixture tests) ──────────────────────────────────────────

describe('extractImportSpecifiers parser coverage', () => {
  it('detects side-effect imports (import "specifier")', () => {
    expect(extractImportSpecifiers("import 'node:fs'")).toContain('node:fs')
  })

  it('detects re-exports (export * from "specifier")', () => {
    expect(extractImportSpecifiers("export * from '../../server/foo.js'")).toContain(
      '../../server/foo.js',
    )
  })

  it('detects named re-exports (export { foo } from "specifier")', () => {
    expect(extractImportSpecifiers("export { foo } from '../../server/bar.js'")).toContain(
      '../../server/bar.js',
    )
  })

  it('side-effect import of node builtin is caught by the builtin check', () => {
    const specifiers = extractImportSpecifiers("import 'node:fs'")
    expect(specifiers.some(isForbiddenNodeBuiltin)).toBe(true)
  })

  it('bare crypto import (not in hand-written list) is caught by builtinModules check', () => {
    expect(isForbiddenNodeBuiltin('crypto')).toBe(true)
  })

  it('bare stream import is caught by builtinModules check', () => {
    expect(isForbiddenNodeBuiltin('stream')).toBe(true)
  })

  it('bare url import is caught by builtinModules check', () => {
    expect(isForbiddenNodeBuiltin('url')).toBe(true)
  })

  it('server re-export is caught by the cross-boundary check', () => {
    const fakeFile = resolve(FIXTURE_BROWSER_APP_DIR, 'lib/dummy.ts')
    const specifiers = extractImportSpecifiers("export * from '../../server/routes/document.js'")
    const violations = specifiers
      .map((s) => forbiddenResolvedPath(fakeFile, s, FIXTURE_BROWSER_APP_DIR))
      .filter((v) => v !== null)
    expect(violations).not.toHaveLength(0)
  })
})

// ── src/shared allowlist unit tests ──────────────────────────────────────────

describe('src/shared allowlist', () => {
  // A representative fixture file two levels below packages/mcp-server/src
  // (matching the depth forbiddenResolvedPath's relative specifiers assume),
  // deliberately outside any real browser app dir so browserAppDir must be
  // passed explicitly.
  const fakeAppFile = resolve(FIXTURE_BROWSER_APP_DIR, 'lib/dummy.ts')
  const check = (specifier: string) =>
    forbiddenResolvedPath(fakeAppFile, specifier, FIXTURE_BROWSER_APP_DIR)

  it('api-contracts/* imports are allowed', () => {
    expect(check('../../shared/api-contracts/document.js')).toBeNull()
    expect(check('../../shared/api-contracts/branches.js')).toBeNull()
  })

  it('explicitly listed browser-safe helpers are allowed', () => {
    expect(check('../../shared/document-backend-contract.js')).toBeNull()
    expect(check('../../shared/external-url-policy.js')).toBeNull()
    expect(check('../../shared/ws-messages.js')).toBeNull()
    expect(check('../../shared/ws-protocol.js')).toBeNull()
  })

  it('relocated daemon-backend transport modules are allowed', () => {
    expect(check('../../shared/daemon-backend.js')).toBeNull()
    expect(check('../../shared/api-client.js')).toBeNull()
    expect(check('../../shared/upload-files.js')).toBeNull()
    expect(check('../../shared/ws-text-message.js')).toBeNull()
    expect(check('../../shared/browser-tracing.js')).toBeNull()
  })

  it('test-utils/* imports are allowed from test files', () => {
    const fakeTestFile = resolve(FIXTURE_BROWSER_APP_DIR, 'lib/dummy.test.ts')
    expect(
      forbiddenResolvedPath(
        fakeTestFile,
        '../../shared/test-utils/fast-check.js',
        FIXTURE_BROWSER_APP_DIR,
      ),
    ).toBeNull()
  })

  it('test-utils/* imports are denied from production source files', () => {
    expect(check('../../shared/test-utils/fast-check.js')).not.toBeNull()
  })

  it('diagnostics/* imports are denied (Node-backed writers not browser-safe)', () => {
    expect(check('../../shared/diagnostics/logger.js')).not.toBeNull()
  })

  it('arbitrary unlisted shared helpers are denied', () => {
    expect(check('../../shared/some-new-node-helper.js')).not.toBeNull()
  })
})

// ── Bare-specifier package-subpath boundary (exports-map driven) ─────────────
// forbiddenResolvedPath only ever inspects relative specifiers ('./...'); a
// bare '@kamiazya/whiteboard-mcp/<subpath>' import — the style apps/web
// actually uses — bails out via its `!specifier.startsWith('.')` guard. The
// tests below pin that gap and close it by resolving each bare subpath
// through packages/mcp-server/package.json's `exports` map back to its
// source file, then re-running the same server/cli/daemon/node-builtin bans
// transitively over that file's relative-import closure.

describe('hole pin: bare-specifier subpath imports bypass forbiddenResolvedPath', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whiteboard-boundary-hole-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('forbiddenResolvedPath sees nothing for a bare subpath specifier reaching a banned target, while the exports-map scan catches it', () => {
    const fromFile = resolve(FIXTURE_BROWSER_APP_DIR, 'lib/dummy.ts')
    const specifier = '@kamiazya/whiteboard-mcp/fixture-subpath'

    // Today's guard: a bare specifier is invisible to it, no matter what it resolves to.
    expect(forbiddenResolvedPath(fromFile, specifier, FIXTURE_BROWSER_APP_DIR)).toBeNull()

    // Fixture package mirroring the real shape: exports subpath -> src/entry.ts -> src/server/leak.js
    mkdirSync(join(dir, 'src/server'), { recursive: true })
    writeFileSync(join(dir, 'src/entry.ts'), "export * from './a.js'\n")
    writeFileSync(join(dir, 'src/a.ts'), "export * from './server/leak.js'\n")
    writeFileSync(join(dir, 'src/server/leak.ts'), 'export const leaked = true\n')
    const exportsMap = {
      './fixture-subpath': { types: './src/entry.ts' },
    }

    const resolvedEntry = resolveMcpSubpathEntry(exportsMap, specifier, dir)
    expect(resolvedEntry).not.toBe('unknown')
    expect(resolvedEntry).not.toBe('root-forbidden')
    const violations = collectTransitiveViolations(resolvedEntry as string, dir)
    expect(
      violations.length,
      'the exports-map scan must catch the chain the relative-only guard misses',
    ).toBeGreaterThan(0)
  })
})

describe('resolveMcpSubpathEntry', () => {
  it('resolves a real subpath against the real exports map to its src/ file', () => {
    const resolved = resolveMcpSubpathEntry(
      MCP_EXPORTS_MAP,
      '@kamiazya/whiteboard-mcp/api-client',
      PACKAGE_ROOT,
    )
    expect(resolved).toBe(resolve(PACKAGE_SRC_DIR, 'shared/api-client.ts'))
  })

  it('every real exports subpath whose types target points into ./src exists on disk', () => {
    const missing: string[] = []
    for (const [subpath, entry] of Object.entries(MCP_EXPORTS_MAP)) {
      if (typeof entry === 'string') continue // e.g. "./package.json": "./package.json"
      const typesPath = entry.types
      if (!typesPath?.startsWith('./src/')) continue
      const full = resolve(PACKAGE_ROOT, typesPath)
      if (!existsSync(full)) missing.push(`${subpath}: ${typesPath}`)
    }
    expect(missing, 'exports map subpath types target must exist on disk').toEqual([])
  })

  it('an unknown subpath is reported, not silently skipped', () => {
    expect(
      resolveMcpSubpathEntry({}, '@kamiazya/whiteboard-mcp/does-not-exist', PACKAGE_ROOT),
    ).toBe('unknown')
  })

  it('the bare package root is reported as forbidden (its types target is compiled dist, not src)', () => {
    expect(resolveMcpSubpathEntry(MCP_EXPORTS_MAP, '@kamiazya/whiteboard-mcp', PACKAGE_ROOT)).toBe(
      'root-forbidden',
    )
  })

  it('a synthetic subpath resolves to its declared types file', () => {
    const exportsMap = { './widget': { types: './src/widget.ts' } }
    expect(
      resolveMcpSubpathEntry(exportsMap, '@kamiazya/whiteboard-mcp/widget', PACKAGE_ROOT),
    ).toBe(resolve(PACKAGE_ROOT, './src/widget.ts'))
  })

  it('a subpath whose types target does not point into ./src is reported, asking the mapper to be extended', () => {
    const exportsMap = { './odd': { types: './dist/odd.d.ts' } }
    expect(resolveMcpSubpathEntry(exportsMap, '@kamiazya/whiteboard-mcp/odd', PACKAGE_ROOT)).toBe(
      'unknown',
    )
  })
})

describe('collectTransitiveViolations', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'whiteboard-boundary-transitive-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('a clean chain with no banned imports yields no violations', () => {
    writeFileSync(join(dir, 'entry.ts'), "export * from './a.js'\n")
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1\n')
    expect(collectTransitiveViolations(join(dir, 'entry.ts'), dir)).toEqual([])
  })

  it('a Node builtin import deep in the closure is caught and names the file that imports it', () => {
    writeFileSync(join(dir, 'entry.ts'), "export * from './a.js'\n")
    writeFileSync(join(dir, 'a.ts'), "export * from './b.js'\n")
    writeFileSync(join(dir, 'b.ts'), "import 'node:fs'\nexport const x = 1\n")
    const violations = collectTransitiveViolations(join(dir, 'entry.ts'), dir)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.some((v) => v.includes('b.ts'))).toBe(true)
  })

  it('a reach into src/server/* deep in the closure is caught', () => {
    // Fixture must live under dir/src (collectTransitiveViolations resolves
    // `relToSrc` against `resolve(packageRoot, 'src')`) with `dir` passed as
    // packageRoot, mirroring the hole-pin fixture above — files written
    // directly under `dir` never resolve into a `server/`-prefixed relToSrc,
    // so the assertion would pass through the "unresolvable" violation branch
    // instead of the server/cli/daemon-reach branch this test claims to pin.
    mkdirSync(join(dir, 'src/server'), { recursive: true })
    writeFileSync(join(dir, 'src/entry.ts'), "export * from './a.js'\n")
    writeFileSync(join(dir, 'src/a.ts'), "export * from './b.js'\n")
    writeFileSync(join(dir, 'src/b.ts'), "export * from './server/leak.js'\n")
    writeFileSync(join(dir, 'src/server/leak.ts'), 'export const leaked = true\n')
    const violations = collectTransitiveViolations(join(dir, 'src/entry.ts'), dir)
    expect(violations.some((v) => v.includes('b.ts'))).toBe(true)
  })

  it('a bare self-package subpath re-import found mid-chain is resolved and its closure scanned too, not just the top-level entry', () => {
    // Mirrors a real shape: an allowlisted src/shared module re-imports another
    // @kamiazya/whiteboard-mcp/<subpath> by its published bare specifier instead
    // of a relative path. Before this test, collectTransitiveViolations's BFS
    // only recursed into relative imports, so this second subpath's own reach
    // into src/server passed unscanned one level deep in the closure.
    mkdirSync(join(dir, 'src/server'), { recursive: true })
    writeFileSync(join(dir, 'src/entry.ts'), "export * from './a.js'\n")
    writeFileSync(
      join(dir, 'src/a.ts'),
      `import '${MCP_PACKAGE_SPECIFIER}/fixture-subpath'\nexport const x = 1\n`,
    )
    writeFileSync(join(dir, 'src/leak-entry.ts'), "export * from './server/leak.js'\n")
    writeFileSync(join(dir, 'src/server/leak.ts'), 'export const leaked = true\n')
    const exportsMap = { './fixture-subpath': { types: './src/leak-entry.ts' } }
    const violations = collectTransitiveViolations(join(dir, 'src/entry.ts'), dir, exportsMap)
    expect(violations.some((v) => v.includes('leak'))).toBe(true)
  })

  it('a cyclic import graph terminates and reports the same violation set', () => {
    writeFileSync(join(dir, 'entry.ts'), "export * from './a.js'\n")
    writeFileSync(join(dir, 'a.ts'), "export * from './b.js'\nimport 'node:fs'\n")
    writeFileSync(join(dir, 'b.ts'), "export * from './a.js'\n")
    const violations = collectTransitiveViolations(join(dir, 'entry.ts'), dir)
    expect(violations.some((v) => v.includes('a.ts'))).toBe(true)
    expect(violations.length).toBe(1)
  })

  it('an unresolvable relative import is a violation, never a silent skip', () => {
    writeFileSync(join(dir, 'entry.ts'), "export * from './missing.js'\n")
    const violations = collectTransitiveViolations(join(dir, 'entry.ts'), dir)
    expect(violations.length).toBeGreaterThan(0)
  })

  it("an unlisted src/shared/* import deep in the closure is caught (mirrors forbiddenResolvedPath's allowlist)", () => {
    mkdirSync(join(dir, 'src/shared'), { recursive: true })
    writeFileSync(join(dir, 'src/entry.ts'), "export * from './a.js'\n")
    writeFileSync(join(dir, 'src/a.ts'), "export * from './shared/not-allowlisted.js'\n")
    writeFileSync(join(dir, 'src/shared/not-allowlisted.ts'), 'export const x = 1\n')
    const violations = collectTransitiveViolations(join(dir, 'src/entry.ts'), dir)
    expect(violations.some((v) => v.includes('not-allowlisted'))).toBe(true)
  })

  it('an allowlisted src/shared/* import is not flagged', () => {
    mkdirSync(join(dir, 'src/shared'), { recursive: true })
    writeFileSync(join(dir, 'src/entry.ts'), "export * from './a.js'\n")
    writeFileSync(join(dir, 'src/a.ts'), "export * from './shared/api-client.js'\n")
    writeFileSync(join(dir, 'src/shared/api-client.ts'), 'export const x = 1\n')
    const violations = collectTransitiveViolations(join(dir, 'src/entry.ts'), dir)
    expect(violations).toEqual([])
  })

  it('resolves a .tsx source file (second extension candidate)', () => {
    writeFileSync(join(dir, 'entry.ts'), "export * from './Component.js'\n")
    writeFileSync(join(dir, 'Component.tsx'), 'export const x = 1\n')
    expect(collectTransitiveViolations(join(dir, 'entry.ts'), dir)).toEqual([])
  })

  it('resolves a directory-style import via its index.ts (third candidate)', () => {
    mkdirSync(join(dir, 'feature'))
    writeFileSync(join(dir, 'entry.ts'), "export * from './feature.js'\n")
    writeFileSync(join(dir, 'feature/index.ts'), 'export const x = 1\n')
    expect(collectTransitiveViolations(join(dir, 'entry.ts'), dir)).toEqual([])
  })

  it('resolves a directory-style import via its index.tsx (fourth candidate)', () => {
    mkdirSync(join(dir, 'widget'))
    writeFileSync(join(dir, 'entry.ts'), "export * from './widget.js'\n")
    writeFileSync(join(dir, 'widget/index.tsx'), 'export const x = 1\n')
    expect(collectTransitiveViolations(join(dir, 'entry.ts'), dir)).toEqual([])
  })
})

describe('TEST_ONLY_SUBPATHS', () => {
  it('every mapped target exists on disk', () => {
    const missing = Object.entries(TEST_ONLY_SUBPATHS).filter(([, target]) => !existsSync(target))
    expect(missing, 'TEST_ONLY_SUBPATHS lists a target with no corresponding source file').toEqual(
      [],
    )
  })

  it('mirrors the test-only aliases declared in apps/web/vitest.config.ts', () => {
    // Read the alias keys straight out of vitest.config.ts (like the
    // pnpm-workspace.yaml check below parses that file directly) instead of
    // comparing against a second hand-written literal — two literals can only
    // ever agree with themselves, never catch a real drift. Only the two
    // aliases resolved inline with `resolve(...)` are test-only; the
    // `...mcpSourceAlias` spread's entries resolve through the real exports
    // map (mcp-source-alias-coverage.test.ts covers those) and this regex
    // does not match a spread, so it can't double-count them.
    const vitestConfigText = readFileSync(resolve(APPS_WEB_DIR, 'vitest.config.ts'), 'utf-8')
    const declaredTestOnlyAliases = [
      ...vitestConfigText.matchAll(/['"]@kamiazya\/whiteboard-mcp\/([\w-]+)['"]\s*:\s*resolve\(/g),
    ].map((m) => m[1])
    expect(
      declaredTestOnlyAliases.sort(),
      'apps/web/vitest.config.ts declares a @kamiazya/whiteboard-mcp/* test-only alias not mirrored in TEST_ONLY_SUBPATHS (or vice versa)',
    ).toEqual(Object.keys(TEST_ONLY_SUBPATHS).sort())
  })
})

describe('checkSubpathImportViolations', () => {
  it('a TEST_ONLY_SUBPATHS import from a non-test file is a violation', () => {
    const violations = checkSubpathImportViolations(
      resolve(APPS_WEB_SRC_DIR, 'pages/SomePage.tsx'),
      `${MCP_PACKAGE_SPECIFIER}/document-backend-contract-suite`,
    )
    expect(
      violations.some((v) => v.includes('is test-only, forbidden from a production source file')),
    ).toBe(true)
  })

  it('the same TEST_ONLY_SUBPATHS import from a test file is not a violation', () => {
    const violations = checkSubpathImportViolations(
      resolve(APPS_WEB_SRC_DIR, 'pages/SomePage.test.tsx'),
      `${MCP_PACKAGE_SPECIFIER}/document-backend-contract-suite`,
    )
    expect(violations).toEqual([])
  })

  // Isolated fixture tests for the sibling branch (entry === 'unknown' ||
  // entry === 'root-forbidden'), mirroring the TEST_ONLY_SUBPATHS branch's own
  // isolated tests above rather than relying on no real apps/web file
  // happening to import an unresolvable/root specifier today.
  it('a subpath absent from the exports map is a violation naming the "unknown" resolution', () => {
    const violations = checkSubpathImportViolations(
      resolve(APPS_WEB_SRC_DIR, 'pages/SomePage.tsx'),
      `${MCP_PACKAGE_SPECIFIER}/does-not-exist`,
    )
    expect(
      violations.some((v) => v.includes('does not resolve through the exports map (unknown)')),
    ).toBe(true)
  })

  it('a bare package-root import is a violation naming the "root-forbidden" resolution', () => {
    const violations = checkSubpathImportViolations(
      resolve(APPS_WEB_SRC_DIR, 'pages/SomePage.tsx'),
      MCP_PACKAGE_SPECIFIER,
    )
    expect(
      violations.some((v) =>
        v.includes('does not resolve through the exports map (root-forbidden)'),
      ),
    ).toBe(true)
  })
})

describe('apps/web bare package-subpath import boundary (exports-map driven)', () => {
  it('every bare @kamiazya/whiteboard-mcp/* import in apps/web/src resolves and its transitive closure is clean', () => {
    const browserAppFiles = collectBrowserAppFiles()
    const violations: string[] = []
    for (const { file } of browserAppFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const specifier of extractImportSpecifiers(source)) {
        if (
          specifier !== MCP_PACKAGE_SPECIFIER &&
          !specifier.startsWith(`${MCP_PACKAGE_SPECIFIER}/`)
        ) {
          continue
        }
        violations.push(...checkSubpathImportViolations(file, specifier))
      }
    }
    expect(
      violations,
      'forbidden cross-boundary imports reached through a bare @kamiazya/whiteboard-mcp/* subpath',
    ).toEqual([])
  })
})

// Checks one '@kamiazya/whiteboard-mcp[/<subpath>]' import specifier found in `file` against the
// TEST_ONLY_SUBPATHS-from-a-production-file rule and the exports-map resolution + transitive scan,
// returning zero or more violation messages. Factored out of the aggregate real-repo scan above so
// the TEST_ONLY_SUBPATHS-from-a-production-file branch has an isolated fixture test instead of
// relying on no production file in the real tree happening to import a test-only alias today.
function checkSubpathImportViolations(file: string, specifier: string): string[] {
  const testOnlySubpath = specifier.slice(`${MCP_PACKAGE_SPECIFIER}/`.length)
  let entry: string | 'unknown' | 'root-forbidden'
  if (Object.hasOwn(TEST_ONLY_SUBPATHS, testOnlySubpath)) {
    if (!isTestFile(file)) {
      return [
        `${relative(REPO_ROOT, file)}: import "${specifier}" is test-only, forbidden from a production source file`,
      ]
    }
    entry = TEST_ONLY_SUBPATHS[testOnlySubpath]
  } else {
    entry = resolveMcpSubpathEntry(MCP_EXPORTS_MAP, specifier, PACKAGE_ROOT)
  }
  if (entry === 'unknown' || entry === 'root-forbidden') {
    return [
      `${relative(REPO_ROOT, file)}: import "${specifier}" does not resolve through the exports map (${entry})`,
    ]
  }
  return collectTransitiveViolations(entry, PACKAGE_ROOT).map(
    (v) => `${relative(REPO_ROOT, file)}: import "${specifier}" -> ${v}`,
  )
}

// Maps a bare '@kamiazya/whiteboard-mcp/<subpath>' (or bare-root) specifier back
// to its source file via packages/mcp-server/package.json's `exports` map, using
// each subpath's `types` target (which points at ./src/*.ts, never dist). The
// bare package root is reported 'root-forbidden' rather than resolved — its own
// `types` target is a compiled dist/ .d.ts, a shape this mapper cannot walk, and
// importing the whole server MCP entry from the browser app would be a violation
// on its face regardless. An entry absent from the map, or whose `types` target
// does not point into ./src, resolves to 'unknown': a subpath the mapper cannot
// vouch for is a violation, never a silent pass.
function resolveMcpSubpathEntry(
  exportsMap: Record<string, { types?: string } | string>,
  specifier: string,
  packageRoot: string,
): string | 'unknown' | 'root-forbidden' {
  if (specifier === MCP_PACKAGE_SPECIFIER) return 'root-forbidden'
  if (!specifier.startsWith(`${MCP_PACKAGE_SPECIFIER}/`)) return 'unknown'
  const subpath = `.${specifier.slice(MCP_PACKAGE_SPECIFIER.length)}`
  const entry = exportsMap[subpath]
  if (!entry || typeof entry === 'string') return 'unknown'
  const typesPath = entry.types
  if (!typesPath?.startsWith('./src/')) return 'unknown'
  return resolve(packageRoot, typesPath)
}

// Two test-only aliases declared in apps/web/vitest.config.ts that have no
// corresponding entry in packages/mcp-server/package.json's exports map — they
// resolve straight to the test-utils source that owns the shared behavioural
// contract, and are only legitimate to import from a test file.
const TEST_ONLY_SUBPATHS: Record<string, string> = {
  'document-backend-contract-suite': resolve(
    PACKAGE_SRC_DIR,
    'shared/test-utils/document-backend-contract.ts',
  ),
  'sse-stream-source-contract': resolve(
    PACKAGE_SRC_DIR,
    'shared/test-utils/sse-stream-source-contract.ts',
  ),
}

// Resolves a relative import specifier (as written against a compiled '.js'
// extension, e.g. './a.js') to its on-disk TypeScript source file. Returns null
// — never guesses — when no candidate exists, so an exotic layout fails loudly
// in collectTransitiveViolations instead of being silently skipped.
function resolveRelativeSourceFile(fromFile: string, specifier: string): string | null {
  const resolvedBase = resolve(dirname(fromFile), specifier).replace(/\.jsx?$/, '')
  const candidates = [
    `${resolvedBase}.ts`,
    `${resolvedBase}.tsx`,
    resolve(resolvedBase, 'index.ts'),
    resolve(resolvedBase, 'index.tsx'),
  ]
  return candidates.find(existsSync) ?? null
}

// BFS over an entry file's transitive closure of imports, applying the same
// bans forbiddenResolvedPath applies to the browser app's own relative
// imports: Node-only builtins, reach into src/server, src/cli, or src/daemon,
// and an unlisted src/shared/* import (resolved against packageRoot's own
// src/ dir, not PACKAGE_SRC_DIR — the fixture-based unit tests below pass a
// synthetic packageRoot with no server/cli/daemon/shared dirs of its own).
// A visited set makes this terminate on a cyclic import graph and gives an
// order-independent result. An unresolvable relative import is a violation,
// not a skip — the property whose absence was this guard's bug in the first
// place. The walk is not limited to relative imports: a bare
// '@kamiazya/whiteboard-mcp/<subpath>' specifier found mid-chain (a src/shared
// module re-importing another subpath by its published name rather than a
// relative path) is resolved through `exportsMap` the same way the top-level
// entry point is, and its resolved file is queued too — otherwise this exact
// bypass class re-opens one BFS level deeper than the entry point.
function collectTransitiveViolations(
  entryFile: string,
  packageRoot: string,
  exportsMap: Record<string, { types?: string } | string> = MCP_EXPORTS_MAP,
): string[] {
  const packageSrcDir = resolve(packageRoot, 'src')
  const violations: string[] = []
  const visited = new Set<string>()
  const queue: string[] = [entryFile]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (visited.has(file)) continue
    visited.add(file)
    const source = readFileSync(file, 'utf-8')
    for (const specifier of extractImportSpecifiers(source)) {
      if (isForbiddenNodeBuiltin(specifier)) {
        violations.push(`${relative(REPO_ROOT, file)}: import "${specifier}" (Node builtin)`)
        continue
      }
      if (
        specifier === MCP_PACKAGE_SPECIFIER ||
        specifier.startsWith(`${MCP_PACKAGE_SPECIFIER}/`)
      ) {
        const resolvedSubpath = resolveMcpSubpathEntry(exportsMap, specifier, packageRoot)
        if (resolvedSubpath === 'unknown' || resolvedSubpath === 'root-forbidden') {
          violations.push(
            `${relative(REPO_ROOT, file)}: import "${specifier}" does not resolve through the exports map (${resolvedSubpath})`,
          )
          continue
        }
        if (!visited.has(resolvedSubpath)) queue.push(resolvedSubpath)
        continue
      }
      if (!specifier.startsWith('.')) continue // bare third-party specifiers are outside this scan's scope
      const resolvedFile = resolveRelativeSourceFile(file, specifier)
      if (resolvedFile === null) {
        violations.push(
          `${relative(REPO_ROOT, file)}: import "${specifier}" could not be resolved on disk`,
        )
        continue
      }
      const relToSrc = relative(packageSrcDir, resolvedFile)
      if (
        relToSrc.startsWith('server/') ||
        relToSrc.startsWith('cli/') ||
        relToSrc.startsWith('daemon/')
      ) {
        violations.push(
          `${relative(REPO_ROOT, file)}: import "${specifier}" (resolves to src/${relToSrc})`,
        )
        continue
      }
      if (relToSrc.startsWith('shared/')) {
        // resolvedFile is the on-disk .ts/.tsx file (resolveRelativeSourceFile guessed the
        // extension), but ALLOWED_SHARED_EXACT is keyed by the .js specifier convention
        // (matching import specifiers, e.g. 'api-client.js') — normalize before comparing.
        const relToShared = relToSrc.slice('shared/'.length).replace(/\.tsx?$/, '.js')
        if (!isAllowedSharedImport(relToShared, file)) {
          violations.push(
            `${relative(REPO_ROOT, file)}: import "${specifier}" (resolves to src/${relToSrc}, not in shared allowlist)`,
          )
          continue
        }
      }
      queue.push(resolvedFile)
    }
  }
  return violations
}

// ── Full codebase scans ───────────────────────────────────────────────────────
// Covers apps/web/src.

describe('browser app import boundary: Node-only builtins', () => {
  const browserAppFiles = collectBrowserAppFiles()

  it('apps/web/src contains TypeScript source files to scan', () => {
    expect(browserAppFiles.length, 'apps/web/src must contain TypeScript files').toBeGreaterThan(0)
  })

  it('no file in browser app source imports a Node-only builtin', () => {
    const violations: string[] = []
    for (const { file } of browserAppFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const specifier of extractImportSpecifiers(source)) {
        if (isForbiddenNodeBuiltin(specifier)) {
          violations.push(`${relative(REPO_ROOT, file)}: import "${specifier}"`)
        }
      }
    }
    expect(
      violations,
      'Node-only builtin imports found in browser app source (these break browser builds)',
    ).toEqual([])
  })
})

describe('browser app import boundary: server / cli / daemon / unallowed shared', () => {
  const browserAppFiles = collectBrowserAppFiles()

  it('no file in browser app source imports from src/server, src/cli, src/daemon, or unallowed src/shared', () => {
    const violations: string[] = []
    for (const { file, browserAppDir } of browserAppFiles) {
      const source = readFileSync(file, 'utf-8')
      for (const specifier of extractImportSpecifiers(source)) {
        const forbidden = forbiddenResolvedPath(file, specifier, browserAppDir)
        if (forbidden !== null) {
          violations.push(
            `${relative(REPO_ROOT, file)}: import "${specifier}" (resolves to src/${forbidden})`,
          )
        }
      }
    }
    expect(
      violations,
      'forbidden cross-boundary imports found in browser app source (break browser bundle or leak Node APIs)',
    ).toEqual([])
  })
})

describe('apps/web/src scan coverage', () => {
  it('apps/web/src is included in browser boundary scan when it exists', () => {
    if (!existsSync(APPS_WEB_SRC_DIR)) return // skeleton only — nothing to scan yet
    const webFiles = collectTsFiles(APPS_WEB_SRC_DIR)
    const scanned = collectBrowserAppFiles().filter(
      ({ browserAppDir }) => browserAppDir === APPS_WEB_SRC_DIR,
    )
    expect(scanned.length, 'all apps/web/src TypeScript files must be in the boundary scan').toBe(
      webFiles.length,
    )
  })

  it('apps/web root contains no emitted .js or .d.ts files (config files must not emit)', () => {
    if (!existsSync(APPS_WEB_DIR)) return
    const emitted: string[] = []
    for (const entry of readdirSync(APPS_WEB_DIR, { withFileTypes: true })) {
      if (entry.isFile() && /\.(js|d\.ts)$/.test(entry.name)) {
        emitted.push(entry.name)
      }
    }
    expect(
      emitted,
      'emitted .js/.d.ts files found in apps/web root — tsc must be run with noEmit to avoid polluting vite/vitest config files',
    ).toEqual([])
  })

  it('apps/web/src contains no emitted .js or .d.ts files (tsc must run with noEmit)', () => {
    if (!existsSync(APPS_WEB_SRC_DIR)) return
    // vite-env.d.ts is a hand-written Vite client type reference, not a tsc emit.
    const HAND_WRITTEN_DTS = new Set(['vite-env.d.ts'])
    const emitted: string[] = []
    for (const entry of readdirSync(APPS_WEB_SRC_DIR, {
      withFileTypes: true,
      recursive: true,
    } as Parameters<typeof readdirSync>[1])) {
      if (typeof entry === 'object' && 'name' in entry) {
        const name = (entry as { name: string }).name
        if (/\.(js|d\.ts)$/.test(name) && !HAND_WRITTEN_DTS.has(name)) {
          emitted.push(name)
        }
      }
    }
    expect(
      emitted,
      'emitted .js/.d.ts files found in apps/web/src — tsc must be run with noEmit to avoid polluting the source tree',
    ).toEqual([])
  })
})

describe('allowed shared modules browser-safety', () => {
  // Verifies that the modules in ALLOWED_SHARED_EXACT and api-contracts/ are actually
  // browser-safe: no Node builtins and no imports from src/server, src/cli, src/daemon.
  // Without this scan, the allowlist could drift (e.g. someone adds `import 'node:fs'`
  // to external-url-policy.ts) without detection.
  const SHARED_SRC_DIR = resolve(PACKAGE_SRC_DIR, 'shared')

  function allowedSharedFiles(): string[] {
    const files: string[] = []
    for (const name of ALLOWED_SHARED_EXACT) {
      // Import specifiers use .js; source files use .ts
      const tsName = name.replace(/\.js$/, '.ts')
      const full = resolve(SHARED_SRC_DIR, tsName)
      if (existsSync(full)) files.push(full)
    }
    const apiContractsDir = resolve(SHARED_SRC_DIR, 'api-contracts')
    if (existsSync(apiContractsDir)) {
      files.push(...collectTsFiles(apiContractsDir))
    }
    return files
  }

  it('allowlisted shared modules exist on disk', () => {
    expect(
      allowedSharedFiles().length,
      'at least one allowed shared module must exist',
    ).toBeGreaterThan(0)
  })

  it('every ALLOWED_SHARED_EXACT entry resolves to a file on disk', () => {
    const missing = [...ALLOWED_SHARED_EXACT]
      .map((name) => name.replace(/\.js$/, '.ts'))
      .filter((tsName) => !existsSync(resolve(SHARED_SRC_DIR, tsName)))
    expect(
      missing,
      'ALLOWED_SHARED_EXACT lists a module with no corresponding source file',
    ).toEqual([])
  })

  it('no allowlisted shared module imports a Node-only builtin', () => {
    const violations: string[] = []
    for (const file of allowedSharedFiles()) {
      const source = readFileSync(file, 'utf-8')
      for (const specifier of extractImportSpecifiers(source)) {
        if (isForbiddenNodeBuiltin(specifier)) {
          violations.push(`${relative(REPO_ROOT, file)}: import "${specifier}"`)
        }
      }
    }
    expect(
      violations,
      'Node-only builtin imports found in an allowlisted shared module (would break browser builds)',
    ).toEqual([])
  })

  it('no allowlisted shared module imports from src/server, src/cli, or src/daemon', () => {
    const violations: string[] = []
    for (const file of allowedSharedFiles()) {
      const source = readFileSync(file, 'utf-8')
      for (const specifier of extractImportSpecifiers(source)) {
        if (!specifier.startsWith('.')) continue
        const resolved = resolve(dirname(file), specifier)
        const relToSrc = relative(PACKAGE_SRC_DIR, resolved)
        if (
          relToSrc.startsWith('server/') ||
          relToSrc.startsWith('cli/') ||
          relToSrc.startsWith('daemon/')
        ) {
          violations.push(
            `${relative(REPO_ROOT, file)}: import "${specifier}" (resolves to src/${relToSrc})`,
          )
        }
      }
    }
    expect(
      violations,
      'server/cli/daemon cross-imports in allowlisted shared modules (would break browser builds)',
    ).toEqual([])
  })
})

// ── Tarball and workspace guards ──────────────────────────────────────────────

describe('@kamiazya/whiteboard-mcp tarball exclusion', () => {
  const pkg = JSON.parse(readFileSync(resolve(PACKAGE_ROOT, 'package.json'), 'utf-8')) as {
    files?: string[]
  }

  it('package.json files field is explicit (must contain dist)', () => {
    expect(
      pkg.files ?? [],
      'package.json must declare an explicit files allowlist containing "dist"',
    ).toContain('dist')
  })

  it('package.json files does not include apps/ (hosted app must not enter npm tarball)', () => {
    const forbidden = (pkg.files ?? []).filter((f) => f === 'apps' || f.startsWith('apps/'))
    expect(
      forbidden,
      'apps/ must not appear in package.json files — hosted app is a deploy target, not an npm artifact',
    ).toEqual([])
  })

  it('package.json files does not include src/ (browser source must not enter npm tarball)', () => {
    const forbidden = (pkg.files ?? []).filter((f) => f === 'src' || f.startsWith('src/'))
    expect(
      forbidden,
      'src/ must not appear in package.json files — only compiled dist/ ships in the tarball',
    ).toEqual([])
  })
})

describe('pnpm workspace apps/* inclusion', () => {
  const workspaceText = readFileSync(resolve(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf-8')

  it('pnpm-workspace.yaml includes apps/* when apps/web/src exists and has source files', () => {
    if (!existsSync(APPS_WEB_SRC_DIR)) {
      // apps/web is a skeleton only — workspace membership deferred until
      // apps/web/src exists with source to build.
      return
    }
    expect(
      workspaceText,
      'pnpm-workspace.yaml must include "apps/*" once apps/web/src exists',
    ).toContain('apps/*')
  })
})

describe('apps/web skeleton', () => {
  const appsWebDir = resolve(REPO_ROOT, 'apps/web')

  it('apps/web exists as the intended hosted browser app root', () => {
    expect(
      existsSync(appsWebDir),
      'apps/web must exist as the target layout for the hosted browser app (Cloudflare Pages root)',
    ).toBe(true)
  })

  it('apps/web/package.json exists', () => {
    expect(
      existsSync(resolve(appsWebDir, 'package.json')),
      'apps/web/package.json must exist',
    ).toBe(true)
  })

  it('apps/web package is private (must never be published to npm)', () => {
    const appsWebPkg = JSON.parse(readFileSync(resolve(appsWebDir, 'package.json'), 'utf-8')) as {
      private?: boolean
    }
    expect(
      appsWebPkg.private,
      'apps/web/package.json must declare "private": true — it is a deploy target, not an npm artifact',
    ).toBe(true)
  })

  it('apps/web is outside packages/ (separation from npm-distributed packages)', () => {
    const relToPackages = relative(resolve(REPO_ROOT, 'packages'), appsWebDir)
    expect(
      relToPackages.startsWith('..'),
      'apps/web must be outside packages/ — deploy targets live in apps/, not packages/',
    ).toBe(true)
  })

  it('apps/web/package.json has scripts.build', () => {
    const pkg = JSON.parse(readFileSync(resolve(appsWebDir, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
    expect(
      pkg.scripts?.build,
      'apps/web/package.json must declare a "build" script so CI can build the hosted app',
    ).toBeTruthy()
  })

  it('apps/web/package.json has scripts.dev', () => {
    const pkg = JSON.parse(readFileSync(resolve(appsWebDir, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, string>
    }
    expect(
      pkg.scripts?.dev,
      'apps/web/package.json must declare a "dev" script for local development',
    ).toBeTruthy()
  })
})

// ── Cloudflare Pages config drift guard ──────────────────────────────────────

describe('apps/web Cloudflare Pages config (wrangler.toml)', () => {
  const wranglerPath = resolve(APPS_WEB_DIR, 'wrangler.toml')

  it('wrangler.toml exists in apps/web', () => {
    expect(
      existsSync(wranglerPath),
      'apps/web/wrangler.toml must exist — Pages project config',
    ).toBe(true)
  })

  it('pages_build_output_dir is "dist"', () => {
    if (!existsSync(wranglerPath)) return
    const content = readFileSync(wranglerPath, 'utf-8')
    expect(content, 'pages_build_output_dir must be "dist" to match Vite build output').toMatch(
      /pages_build_output_dir\s*=\s*["']?dist["']?/,
    )
  })

  it('project name matches production origin path "kamiazya-whiteboard"', () => {
    if (!existsSync(wranglerPath)) return
    const content = readFileSync(wranglerPath, 'utf-8')
    expect(
      content,
      'wrangler.toml name must be "kamiazya-whiteboard" — matches https://kamiazya-whiteboard.pages.dev',
    ).toMatch(/\bname\s*=\s*["']kamiazya-whiteboard["']/)
  })

  it('wrangler.toml does not contain account_id or Cloudflare production secrets', () => {
    if (!existsSync(wranglerPath)) return
    const content = readFileSync(wranglerPath, 'utf-8')
    expect(content, 'account_id must not be committed').not.toContain('account_id')
    for (const secret of CF_SECRETS) {
      expect(content, `${secret} must not be committed`).not.toContain(secret)
    }
  })

  it('wrangler.toml does not hardcode preview origins in any allowed origin list', () => {
    if (!existsSync(wranglerPath)) return
    const content = readFileSync(wranglerPath, 'utf-8')
    // Wildcard globs (*.kamiazya-whiteboard.pages.dev) and concrete preview subdomains are both preview origins.
    expect(content).not.toMatch(/\*\.kamiazya-whiteboard\.pages\.dev/)
    expect(content).not.toMatch(/\*\.pages\.dev/)
    expect(content).not.toMatch(/[a-z0-9-]+\.kamiazya-whiteboard\.pages\.dev/)
  })
})

// ── Cloudflare deploy secrets drift guard ─────────────────────────────────────
// Cloudflare Pages deploy secrets are allowed only in the intentional deploy
// paths: release.yml (tag-gated production deploy, production-web env),
// deploy-preview.yml (main -> "latest" alias), and preview-pr-deploy.yml (the
// trusted workflow_run half that publishes a PR's pre-built artifact). Note
// preview-pr-build.yml is deliberately NOT here — it runs untrusted PR code and
// must never see these secrets. Every other workflow / apps/web config file must
// not embed them — extend the allowlist only for a new, reviewed deploy path.

const CF_SECRETS = ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] as const
const CF_SECRET_WORKFLOW_ALLOWLIST = new Set([
  'release.yml',
  'deploy-preview.yml',
  'preview-pr-deploy.yml',
])

describe('apps/web Cloudflare deploy secrets guard', () => {
  const configFiles = [
    'package.json',
    'vite.config.ts',
    'vitest.config.ts',
    'vitest.browser.config.ts',
  ]
    .map((f) => resolve(APPS_WEB_DIR, f))
    .filter(existsSync)

  it('apps/web config files contain no Cloudflare production secrets', () => {
    const violations: string[] = []
    for (const file of configFiles) {
      const content = readFileSync(file, 'utf-8')
      for (const secret of CF_SECRETS) {
        if (content.includes(secret)) {
          violations.push(`${relative(REPO_ROOT, file)}: contains "${secret}"`)
        }
      }
    }
    expect(violations, 'Cloudflare production secrets must not appear in apps/web config').toEqual(
      [],
    )
  })

  it('only allowlisted workflow files deploy apps/web using Cloudflare production secrets', () => {
    const workflowsDir = resolve(REPO_ROOT, '.github/workflows')
    if (!existsSync(workflowsDir)) return
    const violations: string[] = []
    for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(yml|yaml)$/.test(entry.name)) continue
      if (CF_SECRET_WORKFLOW_ALLOWLIST.has(entry.name)) continue
      const content = readFileSync(resolve(workflowsDir, entry.name), 'utf-8')
      const touchesAppsWeb = content.includes('apps/web') || content.includes('whiteboard-web')
      const hasSecret = CF_SECRETS.some((s) => content.includes(s))
      if (touchesAppsWeb && hasSecret) {
        violations.push(entry.name)
      }
    }
    expect(
      violations,
      'Cloudflare production secrets found in a non-allowlisted workflow — add to CF_SECRET_WORKFLOW_ALLOWLIST if intentional',
    ).toEqual([])
  })

  it('release.yml deploy-web job uses Cloudflare secrets for apps/web deploy', () => {
    // No silent skip: unlike wrangler.toml (guarded by its own existence test above),
    // release.yml has no dedicated existence assertion — a missing file must fail here.
    const releaseYml = resolve(REPO_ROOT, '.github/workflows/release.yml')
    expect(existsSync(releaseYml), 'release.yml must exist').toBe(true)
    const content = readFileSync(releaseYml, 'utf-8')
    expect(content, 'release.yml must contain deploy-web job').toContain('deploy-web:')
    // Extract just the deploy-web job block so assertions are scoped to that job only.
    const deployWebMatch = content.match(/ {2}deploy-web:[\s\S]*?(?=\n {2}[\w][\w-]*:|$)/)
    const deployWebSection = deployWebMatch ? deployWebMatch[0] : ''
    expect(deployWebSection, 'deploy-web job must reference CLOUDFLARE_API_TOKEN').toContain(
      'CLOUDFLARE_API_TOKEN',
    )
    expect(deployWebSection, 'deploy-web job must reference CLOUDFLARE_ACCOUNT_ID').toContain(
      'CLOUDFLARE_ACCOUNT_ID',
    )
    expect(
      matchesEnvironmentProductionWeb(deployWebSection),
      'deploy-web job must declare the production-web environment (secrets scoped to tag-protected env); the string form and the name/url mapping form are both valid, with optional quotes and any key order',
    ).toBe(true)
  })

  it('deploy-web avoids the wrangler-action npm-install fallback (catalog: is pnpm-only)', () => {
    // wrangler-action falls back to `npm i wrangler@4` inside workingDirectory when
    // wrangler is not already installed. npm cannot parse pnpm's catalog: protocol in
    // apps/web/package.json (EUNSUPPORTEDPROTOCOL), so both halves must hold:
    // the action must use pnpm, and wrangler must be preinstalled via devDependencies.
    const releaseYml = resolve(REPO_ROOT, '.github/workflows/release.yml')
    expect(existsSync(releaseYml), 'release.yml must exist').toBe(true)
    const content = readFileSync(releaseYml, 'utf-8')
    const deployWebMatch = content.match(/ {2}deploy-web:[\s\S]*?(?=\n {2}[\w][\w-]*:|$)/)
    const deployWebSection = deployWebMatch ? deployWebMatch[0] : ''
    expect(deployWebSection, 'deploy-web wrangler-action must set packageManager: pnpm').toContain(
      'packageManager: pnpm',
    )

    const appsWebPkg = JSON.parse(readFileSync(resolve(APPS_WEB_DIR, 'package.json'), 'utf-8')) as {
      devDependencies?: Record<string, string>
    }
    expect(
      appsWebPkg.devDependencies?.wrangler,
      'apps/web must declare wrangler as a devDependency so wrangler-action skips its npm install',
    ).toBeTruthy()
  })
})
