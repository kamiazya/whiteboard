// Guard against scope creep on the `./api-contracts` public npm subpath.
//
// The barrel at src/shared/api-contracts/index.ts is deliberately narrow.
// web-app-boundary.test.ts scans every file under src/shared/api-contracts/
// for browser-safety, but it does not — and structurally cannot — assert
// what the barrel itself re-exports. Without this test, someone could add
// `export * from './document-runtime.js'` (or daemon-doctor / export /
// libraries) to the barrel and widen the public semver surface without any
// test noticing.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname -> packages/mcp-server/src/server/release
// The barrel's SOURCE moved to the daemon-client package; the old path is a
// one-line re-export shim that keeps the published subpath alive. The scope
// guard follows the source (that is where a widening would be written), and
// a second assertion pins the shim so the published path cannot silently
// point elsewhere.
const BARREL_PATH = resolve(__dirname, '../../../../daemon-client/src/api-contracts/index.ts')
const SHIM_PATH = resolve(__dirname, '../../shared/api-contracts/index.ts')

function reExportSpecifiers(source: string): string[] {
  const re = /export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g
  return [...source.matchAll(re)].map((match) => match[1]!)
}

describe('api-contracts barrel scope', () => {
  it('the published subpath shim points at the daemon-client barrel and nothing else', () => {
    const shim = reExportSpecifiers(readFileSync(SHIM_PATH, 'utf-8'))
    expect(shim).toEqual(['@kamiazya/whiteboard-daemon-client/api-contracts/index'])
  })

  it('re-exports exactly the declared public surface — no other api-contracts modules', () => {
    const source = readFileSync(BARREL_PATH, 'utf-8')
    const specifiers = reExportSpecifiers(source)
    // '@kamiazya/whiteboard-server-core' is a deliberate widening: the
    // /api/v1 document contracts (canvas list + OKF read) are consumed by
    // apps/web through this barrel so it never imports the shared-layer
    // package directly (architecture-map.md).
    expect(specifiers).toEqual([
      '@kamiazya/whiteboard-server-core',
      './branches.js',
      './document.js',
      // document-url: the live-canvas API's URL shape, exported so apps/web
      // builds request URLs through the same function the daemon's own
      // clients use instead of re-deriving the shape by hand.
      './document-url.js',
      // errors: the ONE daemon error-body contract (title | error+message),
      // exported so every client error surface reads through the same
      // parser instead of hand-rolled per-file field checks.
      './errors.js',
      // fonts: the installable-font catalogue, exported so the settings
      // picker sends an id the daemon gave it. Publishing the contract is
      // what keeps a URL out of the request (ADR-0012).
      './fonts.js',
      './pairing.js',
      // pairing-link: the daemon-pairing-link `#wb=` fragment contract,
      // exported so apps/web parses the same schema wb_pairing_link_create
      // writes instead of a hand-written mirror that can silently drift.
      './pairing-link.js',
      './runtime.js',
    ])
  })
})
