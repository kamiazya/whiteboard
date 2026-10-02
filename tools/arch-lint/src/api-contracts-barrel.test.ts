// Guard against scope creep on the daemon-client api-contracts barrel.
//
// The barrel is deliberately narrow: it is the whole contract surface
// apps/web reads, and arch-lint's structural scan checks browser-safety but
// does not — and structurally cannot — assert what the barrel re-exports.
// Without this test, someone could add another module to the barrel and
// widen the client contract surface without any test noticing.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const BARREL_PATH = resolve(REPO_ROOT, 'packages/daemon-client/src/api-contracts/index.ts')

function reExportSpecifiers(source: string): string[] {
  const re = /export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g
  return [...source.matchAll(re)].map((match) => match[1]!)
}

describe('api-contracts barrel scope', () => {
  it('re-exports exactly the declared public surface — no other api-contracts modules', () => {
    const source = readFileSync(BARREL_PATH, 'utf-8')
    const specifiers = reExportSpecifiers(source)
    // The one '@kamiazya/whiteboard-server-core/*' entry is a deliberate
    // widening: the api error reader (`apiErrorReason`) is consumed by
    // apps/web through this barrel so it never imports the shared-layer
    // package directly (architecture-map.md).
    //
    // It is a SUBPATH, and there is no root entry. That is now a rule rather
    // than a habit — tools/arch-lint's daemon-client-subpath.test.ts fails on
    // a root import anywhere in daemon-client. The tool contracts the
    // `/api/v1` routes answer with arrive as `./v1-answers.js`, DERIVED
    // there and tolerant of a newer daemon's added fields: a schema
    // re-exported from the server-core `/contracts` subpath as it stands is
    // `.strict()`, and an older cached bundle then fails to read a document
    // that was created.
    //
    // `./errors.js` left this list when that contract moved DOWN to
    // server-core: `/api/v1` is served from there, so a contract declared in
    // the CLIENT was above half the routes it describes.
    //
    // It arrives as the SUBPATH rather than the root, and the distinction is
    // load-bearing rather than cosmetic: a module on apps/web's critical
    // path taking it from the root put server-core's whole
    // graph in the entry chunk — 421.4 KB gzip against a 152 KB budget,
    // caught by `smoke:bundle-size` after a build and by nothing before it.
    expect(specifiers).toEqual([
      '@kamiazya/whiteboard-server-core/api-errors',
      // daemon-urls: one builder per daemon route apps/web requests, so a
      // path is spelled once and `daemon-client-urls.routes.test.ts` holds
      // every builder against the routes the daemon really mounts. It
      // imports nothing but the encoders beside it.
      './daemon-urls.js',
      './document.js',
      // document-url: the live-canvas API's URL shape, exported so apps/web
      // builds request URLs through the same function the daemon's own
      // clients use instead of re-deriving the shape by hand.
      './document-url.js',
      // fonts: the installable-font catalogue, exported so the settings
      // picker sends an id the daemon gave it. Publishing the contract is
      // what keeps a URL out of the request (ADR-0012).
      './fonts.js',
      // promotion: the promote request/response and the challenge input
      // both sides hash (ADR-0039), exported so the browser signs exactly
      // the bytes the daemon recomputes instead of a mirror of them.
      './promotion.js',
      './runtime.js',
      './v1-answers.js',
    ])
  })
})
