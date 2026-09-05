// Property catalog: hosted web app / npm package boundary invariants.
// Drift guards:
//   - apps/web's RELATIVE imports ('./...', '../...') must not resolve into
//     packages/mcp-server/src at all, nor import a Node-only builtin
//     (forbiddenResolvedPath)
//   - apps/web must not import '@kamiazya/whiteboard-mcp' AT ALL, bare or
//     subpath: the browser-safe client half lives in
//     @kamiazya/whiteboard-daemon-client (a shared-layer package arch-lint
//     scans structurally), so any reappearing import is boundary drift. The
//     transitive closure walk that used to police the published subpaths
//     retired with them — the package boundary is the guard now.
//   - @kamiazya/whiteboard-mcp package.json files must not include apps/ or src/
//   - pnpm-workspace.yaml must declare apps/* so apps/web participates in workspace builds
//   - apps/web skeleton must exist at the intended deploy-target location
// No PBT: static file-list / import-list guards are clearer as example tests.
//
// The original daemon-served browser UI this test catalog once also scanned
// was deleted in Stage 5 of the MCP-UI retirement (ADR 0001); apps/web is
// the sole browser app now.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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
// The retired dependency: apps/web must have no import of it at all.
const MCP_PACKAGE_SPECIFIER = '@kamiazya/whiteboard-mcp'

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
  // Anything inside packages/mcp-server/src is forbidden territory now that
  // apps/web reads the client half from @kamiazya/whiteboard-daemon-client.
  return relToSrc
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

// ── Full codebase scans ───────────────────────────────────────────────────────
// Covers apps/web/src.

describe('apps/web is off @kamiazya/whiteboard-mcp entirely', () => {
  it('apps/web/package.json depends on daemon-client, not on the server package', () => {
    const webPackage = JSON.parse(readFileSync(resolve(APPS_WEB_DIR, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const allDeps = { ...webPackage.dependencies, ...webPackage.devDependencies }
    expect(allDeps[MCP_PACKAGE_SPECIFIER]).toBeUndefined()
    expect(allDeps['@kamiazya/whiteboard-daemon-client']).toBe('workspace:*')
  })

  it('no file in apps/web/src imports the server package, bare or subpath', () => {
    const violations: string[] = []
    for (const { file } of collectBrowserAppFiles()) {
      const source = readFileSync(file, 'utf-8')
      for (const specifier of extractImportSpecifiers(source)) {
        if (
          specifier === MCP_PACKAGE_SPECIFIER ||
          specifier.startsWith(`${MCP_PACKAGE_SPECIFIER}/`)
        ) {
          violations.push(`${relative(REPO_ROOT, file)}: import "${specifier}"`)
        }
      }
    }
    expect(
      violations,
      'apps/web imports of @kamiazya/whiteboard-mcp — the client half moved to @kamiazya/whiteboard-daemon-client',
    ).toEqual([])
  })
})

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
