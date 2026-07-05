#!/usr/bin/env node
// Smoke-tests the built dist/ directory for Cloudflare Pages artifact integrity.
// Run after `pnpm build` to catch regressions before deploy.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
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

// Collect all text artifact files: html, js, css, plain-text, and _headers.
function collectArtifactFiles(dir) {
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      results.push(...collectArtifactFiles(full))
    } else if (/\.(html|js|css|txt)$/.test(entry.name) || entry.name === '_headers') {
      results.push(full)
    }
  }
  return results
}

// ── dist/ exists ──────────────────────────────────────────────────────────────
console.log('\n[smoke-artifact] dist/ structure')
assert(existsSync(DIST), 'dist/ directory exists')
assert(existsSync(resolve(DIST, 'index.html')), 'dist/index.html exists')

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
