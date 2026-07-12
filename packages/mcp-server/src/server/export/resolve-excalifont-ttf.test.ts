// Regression guard for the R5 (ADR 0001) font-path cutover: headless export
// silently falls back to system fonts on a wrong path (see the `catch {}` in
// resolveExcalifontTtf), so a stale font-path candidate would never surface
// as a test failure in the PNG-only headless-renderer.test.ts above it. This
// test asserts the real dist/web-app layout resolves to a non-null buffer.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveExcalifontTtf } from './headless-renderer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname → packages/mcp-server/src/server/export
const PACKAGE_ROOT = resolve(__dirname, '../../..')
const DIST_WEB_APP_DIR = join(PACKAGE_ROOT, 'dist', 'web-app')
const DIST_WEB_APP_FONTS_DIR = join(DIST_WEB_APP_DIR, 'fonts', 'Excalifont')

// Resolve through Node's own module resolution rather than reading pnpm's
// .pnpm layout: that layout is an implementation detail that changes across
// pnpm versions and does not exist at all under a hoisted linker or another
// package manager.
function findUpstreamExcalifontDir(): string {
  // The package's own entry (dist/prod/index.js) ships its fonts alongside it;
  // ./package.json is not in the package's `exports`, so resolve the entry.
  const entryPath = fileURLToPath(import.meta.resolve('@excalidraw/excalidraw'))
  return resolve(dirname(entryPath), 'fonts/Excalifont')
}

describe('resolveExcalifontTtf against the real dist/web-app layout', () => {
  // Never delete a real apps/web build output that predates this test —
  // only clean up the fixture directory this test itself created.
  const distWebAppPreexisted = existsSync(DIST_WEB_APP_DIR)
  let createdFontsDir = false

  beforeAll(() => {
    if (existsSync(DIST_WEB_APP_FONTS_DIR)) return
    // Mirror what apps/web's vite build + copy-into-mcp-dist.mjs produce:
    // dist/web-app/fonts/Excalifont/*.woff2 (flat, no node_modules subpath).
    mkdirSync(DIST_WEB_APP_FONTS_DIR, { recursive: true })
    createdFontsDir = true
    cpSync(findUpstreamExcalifontDir(), DIST_WEB_APP_FONTS_DIR, { recursive: true })
  })

  afterAll(() => {
    if (!createdFontsDir) return
    if (distWebAppPreexisted) {
      rmSync(DIST_WEB_APP_FONTS_DIR, { recursive: true, force: true })
    } else {
      rmSync(DIST_WEB_APP_DIR, { recursive: true, force: true })
    }
  })

  it('returns a non-null decoded font buffer, not the silent system-font fallback', async () => {
    const buf = await resolveExcalifontTtf()
    expect(buf).not.toBeNull()
    expect(buf?.byteLength).toBeGreaterThan(0)
  })
})
