// Property catalog: hosted web app / npm package boundary invariants.
// Drift guards:
//   - packages/mcp-server/src/app must not import src/server, src/cli, src/daemon,
//     or Node-only builtins; src/shared imports are restricted to an explicit allowlist
//   - @kamiazya/whiteboard-mcp package.json files must not include apps/ or src/
//   - pnpm-workspace.yaml must declare apps/* so apps/web participates in workspace builds
//   - apps/web skeleton must exist at the intended deploy-target location
// No PBT: static file-list / import-list guards are clearer as example tests.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname → packages/mcp-server/src/server/release
const REPO_ROOT = resolve(__dirname, '../../../../..')
const PACKAGE_ROOT = resolve(__dirname, '../../..')
const PACKAGE_SRC_DIR = resolve(PACKAGE_ROOT, 'src')
const APP_SRC_DIR = resolve(PACKAGE_SRC_DIR, 'app')
const APPS_WEB_DIR = resolve(REPO_ROOT, 'apps/web')
const APPS_WEB_SRC_DIR = resolve(REPO_ROOT, 'apps/web/src')

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
// apps/web/src is included when it exists so boundary violations there are caught automatically.
function collectBrowserAppFiles(): { file: string; browserAppDir: string }[] {
  const results: { file: string; browserAppDir: string }[] = []
  for (const file of collectTsFiles(APP_SRC_DIR)) {
    results.push({ file, browserAppDir: APP_SRC_DIR })
  }
  if (existsSync(APPS_WEB_SRC_DIR)) {
    for (const file of collectTsFiles(APPS_WEB_SRC_DIR)) {
      results.push({ file, browserAppDir: APPS_WEB_SRC_DIR })
    }
  }
  return results
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

// Explicit allowlist of browser-safe surfaces within src/shared/ that src/app may import.
// Any src/shared/* import NOT matching this list is a boundary violation.
// Add new entries here only after confirming the module contains no Node-only APIs.
const ALLOWED_SHARED_EXACT = new Set([
  'canvas-backend-contract.js', // transport/callback seam — types + Zod re-exports only, no Node APIs
  'external-url-policy.js', // pure URL validation, no Node APIs
  'loro-raw-element.js', // Zod schema for Loro-stored element shape — zod-only, no Node APIs
  'resolve-parented-elements.js', // pure data transformation
  'ws-messages.js', // WebSocket protocol types/constants
  'ws-protocol.js', // WebSocket protocol helpers
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
// browserAppDir defaults to APP_SRC_DIR for backward-compat with unit fixture tests.
function forbiddenResolvedPath(
  fromFile: string,
  specifier: string,
  browserAppDir = APP_SRC_DIR,
): string | null {
  if (!specifier.startsWith('.')) return null
  const resolved = resolve(dirname(fromFile), specifier)
  if (resolved.startsWith(browserAppDir + '/') || resolved === browserAppDir) return null
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
    const fakeFile = resolve(APP_SRC_DIR, 'lib/dummy.ts')
    const specifiers = extractImportSpecifiers("export * from '../../server/routes/canvas.js'")
    const violations = specifiers
      .map((s) => forbiddenResolvedPath(fakeFile, s))
      .filter((v) => v !== null)
    expect(violations).not.toHaveLength(0)
  })
})

// ── src/shared allowlist unit tests ──────────────────────────────────────────

describe('src/shared allowlist', () => {
  // A representative file at src/app/lib/ depth, two levels up to reach src/shared/
  const fakeAppFile = resolve(APP_SRC_DIR, 'lib/dummy.ts')

  it('api-contracts/* imports are allowed', () => {
    expect(forbiddenResolvedPath(fakeAppFile, '../../shared/api-contracts/canvas.js')).toBeNull()
    expect(forbiddenResolvedPath(fakeAppFile, '../../shared/api-contracts/branches.js')).toBeNull()
  })

  it('explicitly listed browser-safe helpers are allowed', () => {
    expect(forbiddenResolvedPath(fakeAppFile, '../../shared/canvas-backend-contract.js')).toBeNull()
    expect(forbiddenResolvedPath(fakeAppFile, '../../shared/external-url-policy.js')).toBeNull()
    expect(
      forbiddenResolvedPath(fakeAppFile, '../../shared/resolve-parented-elements.js'),
    ).toBeNull()
    expect(forbiddenResolvedPath(fakeAppFile, '../../shared/ws-messages.js')).toBeNull()
    expect(forbiddenResolvedPath(fakeAppFile, '../../shared/ws-protocol.js')).toBeNull()
  })

  it('test-utils/* imports are allowed from test files', () => {
    const fakeTestFile = resolve(APP_SRC_DIR, 'lib/dummy.test.ts')
    expect(forbiddenResolvedPath(fakeTestFile, '../../shared/test-utils/fast-check.js')).toBeNull()
  })

  it('test-utils/* imports are denied from production source files', () => {
    expect(
      forbiddenResolvedPath(fakeAppFile, '../../shared/test-utils/fast-check.js'),
    ).not.toBeNull()
  })

  it('diagnostics/* imports are denied (Node-backed writers not browser-safe)', () => {
    expect(forbiddenResolvedPath(fakeAppFile, '../../shared/diagnostics/logger.js')).not.toBeNull()
  })

  it('arbitrary unlisted shared helpers are denied', () => {
    expect(
      forbiddenResolvedPath(fakeAppFile, '../../shared/some-new-node-helper.js'),
    ).not.toBeNull()
  })
})

// ── Full codebase scans ───────────────────────────────────────────────────────
// Covers packages/mcp-server/src/app and apps/web/src (when it exists).

describe('browser app import boundary: Node-only builtins', () => {
  const browserAppFiles = collectBrowserAppFiles()

  it('src/app contains TypeScript source files to scan', () => {
    const appCount = browserAppFiles.filter(
      ({ browserAppDir }) => browserAppDir === APP_SRC_DIR,
    ).length
    expect(appCount, 'src/app must contain TypeScript files').toBeGreaterThan(0)
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

  it('project name matches production origin slug "kamiazya-whiteboard"', () => {
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
// Production Cloudflare Pages deploy secrets are allowed only in release.yml
// (the deploy-web job). All other workflow files and apps/web config files must
// not embed these secrets — add to the allowlist below if a second deploy path
// is introduced intentionally.

const CF_SECRETS = ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'] as const
const CF_SECRET_WORKFLOW_ALLOWLIST = new Set(['release.yml'])

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
    const releaseYml = resolve(REPO_ROOT, '.github/workflows/release.yml')
    if (!existsSync(releaseYml)) return
    const content = readFileSync(releaseYml, 'utf-8')
    expect(content, 'release.yml must contain deploy-web job').toContain('deploy-web:')
    // Extract just the deploy-web job block so assertions are scoped to that job only.
    const deployWebMatch = content.match(/  deploy-web:[\s\S]*?(?=\n  [\w][\w-]*:|$)/)
    const deployWebSection = deployWebMatch ? deployWebMatch[0] : ''
    expect(deployWebSection, 'deploy-web job must reference CLOUDFLARE_API_TOKEN').toContain(
      'CLOUDFLARE_API_TOKEN',
    )
    expect(deployWebSection, 'deploy-web job must reference CLOUDFLARE_ACCOUNT_ID').toContain(
      'CLOUDFLARE_ACCOUNT_ID',
    )
    expect(
      deployWebSection,
      'deploy-web job must declare environment: production-web (secrets scoped to tag-protected env)',
    ).toContain('environment: production-web')
  })
})
