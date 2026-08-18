import { describe, expect, it } from 'vitest'

/**
 * Imports the package by its published specifier (not a relative path), so
 * this exercises package.json `exports` resolution the same way a consumer
 * (workspace, mcp-server, apps/web) will. Confirms the barrel is
 * consumable end to end with no node built-ins, DOM, or inversify pulled in
 * transitively.
 */
describe('ports package smoke', () => {
  // Everything after the import is pure in-memory arithmetic; the whole cost
  // is resolving and transforming the barrel through package `exports` for
  // the first time. CI runs seven vitest projects in one step, and under that
  // contention the cold resolve alone can exceed the 5s default — which
  // reports as a timeout on a test whose subject is resolvability, not
  // latency. The generous budget belongs to this test, not to the project.
  it('imports the barrel via its package specifier and exercises a full round-trip', async () => {
    const pkg = await import('@kamiazya/whiteboard-ports')

    const bytes = new Uint8Array([10, 20, 30, 40, 50])
    const { manifest, chunks } = pkg.chunkSnapshot(bytes, 2)
    expect(pkg.snapshotManifestSchema.parse(manifest)).toEqual(manifest)
    expect(pkg.reassembleSnapshot(manifest, chunks)).toEqual(bytes)

    expect(() => pkg.reassembleSnapshot(manifest, chunks.slice(0, chunks.length - 1))).toThrowError(
      pkg.SnapshotReassemblyError,
    )
    try {
      pkg.reassembleSnapshot(manifest, chunks.slice(0, chunks.length - 1))
      expect.fail('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(pkg.SnapshotReassemblyError)
      expect((error as InstanceType<typeof pkg.SnapshotReassemblyError>).code).toBe('MISSING_CHUNK')
    }

    const docRef = pkg.docRefSchema.parse({
      kind: 'document',
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
    expect(docRef.kind).toBe('document')

    expect(pkg.TOKENS.DocumentStore).toBe(Symbol.for('whiteboard.ports.DocumentStore'))
    expect(pkg.negotiateProtocolVersion([1, 2], [2, 3])).toBe(2)
  }, 30_000)
})
