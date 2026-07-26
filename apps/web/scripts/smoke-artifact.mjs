#!/usr/bin/env node
// Smoke-tests the built dist/ directory for Cloudflare Pages artifact integrity.
// Run after `pnpm build` to catch regressions before deploy.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = resolve(ROOT, 'dist')

let failures = 0

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL  ${message}`)
    failures++
  } else {
    console.log(`  pass  ${message}`)
  }
}

function readDist(rel) {
  const p = resolve(DIST, rel)
  if (!existsSync(p)) return null
  return readFileSync(p, 'utf-8')
}

// Collect all text artifact files: html, js, css, plain-text, and the
// Cloudflare Pages config files (_headers, _redirects).
function collectArtifactFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectArtifactFiles(full))
    } else if (
      /\.(html|js|css|txt)$/.test(entry.name) ||
      entry.name === '_headers' ||
      entry.name === '_redirects'
    ) {
      results.push(full)
    }
  }
  return results
}

// Recursively lists every REGULAR file under `dir` (no extension filter —
// unlike collectArtifactFiles above, this must also see binary assets like
// .wasm so a stripped-source_map regression can't hide behind an unusual
// extension).
export function listAllRegularFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...listAllRegularFiles(full))
    } else if (entry.isFile()) {
      results.push(full)
    }
  }
  return results
}

// Scans every regular file under `dir` for `needle` as raw bytes (not text
// decoding — a binary file's bytes may not round-trip through a text
// encoding, and the whole point is to catch it regardless). Returns the
// list of offending file paths.
export function findFilesContainingBytes(dir, needle) {
  const needleBuffer = Buffer.from(needle, 'utf-8')
  const offenders = []
  for (const filePath of listAllRegularFiles(dir)) {
    const bytes = readFileSync(filePath)
    if (bytes.includes(needleBuffer)) {
      offenders.push(filePath)
    }
  }
  return offenders
}

// Guarded behind the import.meta.url check at the bottom so importing
// listAllRegularFiles/findFilesContainingBytes for a unit test does not run
// the whole dist/ smoke (and does not process.exit the test process).
function main() {
  // ── dist/ exists ──────────────────────────────────────────────────────────────
  console.log('\n[smoke-artifact] dist/ structure')
  assert(existsSync(DIST), 'dist/ directory exists')
  assert(existsSync(resolve(DIST, 'index.html')), 'dist/index.html exists')

  // Self-hosted Excalidraw fonts: Excalidraw resolves
  // `${EXCALIDRAW_ASSET_PATH}fonts/<Family>/…` and the CSP blocks the esm.sh
  // fallback, so the fonts must land at dist/fonts/<Family>/ exactly.
  assert(
    existsSync(resolve(DIST, 'fonts/Excalifont')),
    'dist/fonts/Excalifont/ exists (self-hosted)',
  )
  assert(
    !existsSync(resolve(DIST, 'fonts/node_modules')),
    'dist/fonts has no node_modules path prefix (copy structure regression)',
  )

  // ── _headers copied ───────────────────────────────────────────────────────────
  console.log('\n[smoke-artifact] _headers')
  const headers = readDist('_headers')
  assert(headers !== null, 'dist/_headers exists (Cloudflare Pages security headers)')

  if (headers !== null) {
    assert(headers.includes('X-Content-Type-Options'), '_headers: X-Content-Type-Options present')
    assert(headers.includes('X-Frame-Options'), '_headers: X-Frame-Options present')
    assert(headers.includes('Content-Security-Policy'), '_headers: Content-Security-Policy present')
    assert(headers.includes('frame-ancestors'), '_headers: frame-ancestors directive present')
    assert(
      headers.includes("frame-ancestors 'none'"),
      "_headers: frame-ancestors 'none' (no embedding allowed)",
    )
    assert(headers.includes('Referrer-Policy'), '_headers: Referrer-Policy present')
    assert(headers.includes('Permissions-Policy'), '_headers: Permissions-Policy present')
  }

  // ── _redirects copied (SPA fallback) ──────────────────────────────────────────
  // apps/web has client-side routes with no matching dist/ file
  // (/canvas/:workspaceId/:slug, /w/:workspaceId, /local/:canvasId); without this
  // rule Cloudflare Pages 404s a direct load or reload of any of them.
  console.log('\n[smoke-artifact] _redirects (SPA fallback)')
  const redirects = readDist('_redirects')
  assert(redirects !== null, 'dist/_redirects exists (Cloudflare Pages SPA fallback)')
  if (redirects !== null) {
    assert(
      /^\/\*\s+\/index\.html\s+200\s*$/m.test(redirects),
      '_redirects: catch-all rewrite to /index.html with a 200 (not a 3xx redirect)',
    )
  }

  // ── CSP integrity ─────────────────────────────────────────────────────────────
  console.log('\n[smoke-artifact] CSP directives')
  if (headers !== null) {
    const cspMatch = headers.match(/Content-Security-Policy:\s*(.+)/)
    const csp = cspMatch ? cspMatch[1] : ''

    assert(csp.includes("default-src 'self'"), "CSP: default-src 'self'")
    assert(csp.includes("base-uri 'none'"), "CSP: base-uri 'none'")
    assert(csp.includes("object-src 'none'"), "CSP: object-src 'none'")
    assert(csp.includes("script-src 'self'"), "CSP: script-src 'self'")
    // loro-crdt is WASM; without 'wasm-unsafe-eval' the app dies at bootstrap (blank page).
    assert(
      /script-src[^;]*'wasm-unsafe-eval'/.test(csp),
      "CSP: 'wasm-unsafe-eval' for loro-crdt WASM",
    )

    // No wildcard sources that would defeat the CSP
    assert(!csp.includes('script-src *'), 'CSP: no wildcard script-src')
    assert(!csp.includes('default-src *'), 'CSP: no wildcard default-src')
    assert(!csp.includes('connect-src *'), 'CSP: no wildcard connect-src')
    assert(!csp.match(/script-src[^;]*'unsafe-eval'/), "CSP: no 'unsafe-eval' in script-src")
  }

  // ── Preview-origin rejection wired up in the bundle ───────────────────────────
  // Static analysis: verify the built JS bundle includes the origin-classification
  // string constant and the browser-origin access that App.tsx passes at bootstrap.
  // If App.tsx is changed to use resolveProviderStateFromRaw (which has no
  // browserOrigin check) the bundle will still contain `whiteboard.pages.dev` but
  // will not contain a `location.origin` access near the bootstrap call — however
  // the more reliable signal is that both strings must survive the build.
  console.log('\n[smoke-artifact] preview-origin rejection wired up in bundle')
  const assetsDir = resolve(DIST, 'assets')
  const jsBundles = existsSync(assetsDir)
    ? readdirSync(assetsDir)
        .filter((f) => f.endsWith('.js'))
        .map((f) => readFileSync(join(assetsDir, f), 'utf-8'))
    : []

  assert(jsBundles.length > 0, 'at least one JS bundle exists in dist/assets/')
  if (jsBundles.length > 0) {
    const bundleAll = jsBundles.join('\n')
    assert(
      bundleAll.includes('whiteboard.pages.dev'),
      'bundle contains "whiteboard.pages.dev" (origin-policy string constant)',
    )
    // window.location.origin is accessed via `location.origin` after minification.
    assert(
      bundleAll.includes('location.origin'),
      'bundle contains "location.origin" (App bootstrap passes browser origin to hosted provider)',
    )
  }

  // ── No unpkg.com references anywhere in dist/ ─────────────────────────────────
  // loro-crdt's bundler WASM ships a sourceMappingURL custom section pointing
  // at unpkg.com; vite-plugin-strip-wasm-sourcemap.ts strips it at build time
  // (see that file for why — CSP connect-src must not be widened to third-party
  // CDNs just to permit a DevTools-only sourcemap fetch). Raw-bytes, whole-dist
  // scan: no extension allowlist, so a regression can't hide in a binary file
  // or an unusual extension.
  console.log('\n[smoke-artifact] no unpkg.com references in dist/ (raw bytes, whole tree)')
  if (existsSync(DIST)) {
    const offenders = findFilesContainingBytes(DIST, 'unpkg.com')
    assert(
      offenders.length === 0,
      `no dist/ file contains "unpkg.com" (found in: ${offenders.join(', ')})`,
    )
  }

  // ── No secrets in any artifact file ───────────────────────────────────────────
  console.log('\n[smoke-artifact] no secrets in dist/ artifacts')
  const SECRET_PATTERNS = [
    /CLOUDFLARE_API_TOKEN/i,
    /CF_API_TOKEN/i,
    /CLOUDFLARE_ACCOUNT_ID/i,
    /account_id\s*=/i,
    /\bsecret\b.*[:=]\s*["'][^"']{8,}/i,
  ]
  const artifactFiles = existsSync(DIST) ? collectArtifactFiles(DIST) : []
  assert(artifactFiles.length > 0, 'artifact files found to scan')
  for (const filePath of artifactFiles) {
    const content = readFileSync(filePath, 'utf-8')
    const rel = filePath.replace(DIST + '/', '')
    for (const pattern of SECRET_PATTERNS) {
      assert(!pattern.test(content), `${rel}: no match for ${pattern}`)
    }
  }

  // ── Result ────────────────────────────────────────────────────────────────────
  console.log('')
  if (failures > 0) {
    console.error(`[smoke-artifact] ${failures} check(s) failed`)
    process.exit(1)
  } else {
    console.log('[smoke-artifact] all checks passed')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
