// @vitest-environment node
// A screen under `pages/` composes; the CRDT is a browser mechanic and lives
// under `lib/`, which is where every other module that names `loro-crdt`
// already sits. A page that opens a record and writes ops itself is a second
// copy of what a keeper does, and nothing above `lib/` can then be reviewed
// for what a write may touch (the offline replica page wrote CRDT ops and
// kept its own save queue for exactly this reason, unseen).
//
// Type-only imports count: a page naming `LoroDoc` is a page whose state is
// the CRDT, whatever tsc erases. Test files are exempt — a test that builds a
// record as its fixture is doing setup.
//
// Sources come from `import.meta.glob` with `?raw`, so this needs no `node:fs`
// (apps/web is browser-only, see web-app-boundary.test.ts).

import { describe, expect, it } from 'vitest'

const PAGE_SOURCES = import.meta.glob(['./pages/**/*.{ts,tsx}', '!./pages/**/*.test.*'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const LORO_CRDT = /(?:from|import)\s*\(?\s*['"]loro-crdt['"]/

describe('pages/ never name the CRDT', () => {
  it('scans a plausible number of page modules, so a broken glob cannot pass vacuously', () => {
    expect(Object.keys(PAGE_SOURCES).length).toBeGreaterThan(30)
    expect(Object.keys(PAGE_SOURCES)).toContain('./pages/ReplicaReadPage.tsx')
  })

  it('imports loro-crdt from no page module', () => {
    const offenders = Object.entries(PAGE_SOURCES)
      .filter(([, source]) => LORO_CRDT.test(source))
      .map(([path]) => path)
    expect(offenders).toEqual([])
  })

  it('recognises each way a page can import it', () => {
    for (const line of [
      "import { LoroDoc } from 'loro-crdt'",
      "import type { LoroDoc } from 'loro-crdt'",
      "export { LoroDoc } from 'loro-crdt'",
      "const mod = import('loro-crdt')",
      "import 'loro-crdt'",
    ]) {
      expect(LORO_CRDT.test(line), line).toBe(true)
    }
    expect(LORO_CRDT.test("import { x } from '../lib/loro-store.js'")).toBe(false)
  })
})
