/**
 * Which api-contracts modules may import server-core's ROOT, pinned by
 * equality — because the answer is a bundle budget, not a style.
 *
 * daemon-client is `sideEffects: false`, so a module the web app's critical
 * path never needs is dropped whole, imports and all; `document.ts` imports
 * the root and costs nothing that way. A module the critical path DOES need
 * keeps every import it makes, and server-core's root is not
 * side-effect-free to the bundler, so it arrives whole — loro's WASM
 * bindings included. Measured when `pairing.ts` (statically reached by the
 * pairing hook and the identity pin) imported the root for one schema:
 * critical-path JS went from 144.5 KB gzip in 27 files to 413.8 KB in 31,
 * against a 152 KB budget. A subpath into the one module wanted
 * (`server-core/versions/version-entry`, zod and model only) costs nothing.
 *
 * `apps/web`'s entry-graph guard cannot see this: it walks `apps/web/src`
 * and stops at the package boundary. The CI bundle-size smoke catches it
 * after a production build; this is the nearest-layer version that names
 * the module.
 */
import { describe, expect, it } from 'vitest'

const SOURCES = import.meta.glob('./*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const ROOT_IMPORT = /from '@kamiazya\/whiteboard-server-core'/

describe('server-core root imports in api-contracts', () => {
  it('only the barrel and the document contract import the root', () => {
    const importers = Object.entries(SOURCES)
      .filter(([path]) => !path.endsWith('.test.ts') && !path.endsWith('.test-helper.ts'))
      .filter(([, source]) => ROOT_IMPORT.test(source))
      .map(([path]) => path)
      .sort()
    expect(importers).toEqual(['./document.ts', './index.ts'])
  })
})
