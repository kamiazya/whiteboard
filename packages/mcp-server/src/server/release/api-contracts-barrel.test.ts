// Guard against scope creep on the `./api-contracts` public npm subpath.
//
// The barrel at src/shared/api-contracts/index.ts is deliberately narrow.
// web-app-boundary.test.ts scans every file under src/shared/api-contracts/
// for browser-safety, but it does not — and structurally cannot — assert
// what the barrel itself re-exports. Without this test, someone could add
// `export * from './canvas-runtime.js'` (or daemon-doctor / export /
// libraries) to the barrel and widen the public semver surface without any
// test noticing.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname -> packages/mcp-server/src/server/release
const BARREL_PATH = resolve(__dirname, '../../shared/api-contracts/index.ts')

function reExportSpecifiers(source: string): string[] {
  const re = /export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g
  return [...source.matchAll(re)].map((match) => match[1]!)
}

describe('api-contracts barrel scope', () => {
  it('re-exports exactly the declared public surface — no other api-contracts modules', () => {
    const source = readFileSync(BARREL_PATH, 'utf-8')
    const specifiers = reExportSpecifiers(source)
    // '@kamiazya/whiteboard-server-core' is a deliberate widening: the
    // OpenCanvas /api/v1 contracts (canvas list + OKF read) are consumed by
    // apps/web through this barrel so it never imports the shared-layer
    // package directly (architecture-map.md).
    expect(specifiers).toEqual([
      '@kamiazya/whiteboard-server-core',
      './branches.js',
      './canvas.js',
      './runtime.js',
    ])
  })
})
