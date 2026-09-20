// @vitest-environment node
/**
 * Two structural invariants of the ONE-factory design (ADR-0042/0043 S4b):
 *
 * - `replica-store.ts` is the only module that imports the S4a session-key
 *   holder (`sessionKey`/`replicaKeyProviderFor`). A second importer would
 *   be a second place deciding whether a document is sealed or plaintext,
 *   which is exactly the split the ONE factory exists to rule out.
 * - `replica-store.ts` is the only module that constructs `IdbDocumentStore`
 *   directly. A construction anywhere else bypasses the factory entirely and
 *   writes a replica plaintext by construction — the bug this whole
 *   increment exists to make impossible, not merely unlikely.
 *
 * Both are scanned rather than remembered, so a later call site that
 * reaches for `new IdbDocumentStore(...)` the way `replica-refresh.ts` used
 * to fails the build instead of shipping a plaintext replica silently.
 */
import { describe, expect, it } from 'vitest'

// `?raw` rather than node:fs — apps/web is browser-only and must not import
// a Node builtin (`web-app-boundary.test.ts` pins that), matching every
// other source scan in this package (see keeper-parity.test.ts).
const sources = import.meta.glob('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function nonTestPaths(): string[] {
  return Object.keys(sources)
    .filter((path) => !path.includes('.test.'))
    .map((path) => path.replace(/^\//, ''))
}

describe('the replica session-key holder is imported from exactly one module', () => {
  const paths = nonTestPaths()

  it('scans a plausible number of source files', () => {
    // A glob that stopped matching would otherwise report every entry below
    // as "nothing imports it", which reads as a pass rather than a broken scan.
    expect(paths.length).toBeGreaterThan(100)
  })

  it('imports sessionKey/replicaKeyProviderFor from src/lib/replica-store.ts and nowhere else', () => {
    // `passkey-session.ts` legitimately imports the SIBLING `BindOutcome`
    // type from the same subpath, so the scan matches the two named values
    // that actually decide sealed-vs-plaintext rather than the module
    // specifier alone.
    const importLine =
      /import\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"][^'"]*replica-session-key(\.js)?['"]/g
    const importers = paths.filter((path) => {
      const text = sources[`/${path}`] ?? ''
      const lines = text.match(importLine) ?? []
      return lines.some((line) => /\b(sessionKey|replicaKeyProviderFor)\b/.test(line))
    })
    expect(importers).toEqual(['src/lib/replica-store.ts'])
  })
})

describe('IdbDocumentStore is constructed from exactly one module', () => {
  const paths = nonTestPaths()

  it('scans a plausible number of source files', () => {
    expect(paths.length).toBeGreaterThan(100)
  })

  it('constructs `new IdbDocumentStore(` from src/lib/replica-store.ts and nowhere else', () => {
    const constructors = paths.filter((path) => {
      const text = sources[`/${path}`] ?? ''
      return text.includes('new IdbDocumentStore(')
    })
    expect(constructors).toEqual(['src/lib/replica-store.ts'])
  })
})
