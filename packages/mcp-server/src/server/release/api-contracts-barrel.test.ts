// Guard against scope creep on the `./api-contracts` public npm subpath.
//
// The barrel at src/shared/api-contracts/index.ts is deliberately narrow
// (branches + canvas only). web-app-boundary.test.ts scans every file under
// src/shared/api-contracts/ for browser-safety, but it does not — and
// structurally cannot — assert what the barrel itself re-exports. Without
// this test, someone could add `export * from './runtime.js'` (or
// canvas-runtime / daemon-doctor / export / libraries / palette) to the
// barrel and widen the public semver surface without any test noticing.

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
  it('re-exports exactly branches and canvas — no other api-contracts modules', () => {
    const source = readFileSync(BARREL_PATH, 'utf-8')
    const specifiers = reExportSpecifiers(source)
    expect(specifiers).toEqual(['./branches.js', './canvas.js'])
  })
})
