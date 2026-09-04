/**
 * 3-B: LoroStore — IndexedDB v2 Loro snapshot+delta store.
 *
 * Real browser tests because IndexedDB requires a browser environment.
 */

// Stays in REAL-browser mode on purpose: this file is part of the real-IDB
// fidelity contract (transaction/upgrade/abort semantics fake-indexeddb only
// approximates). IndexedDB-only suites with no such stake run in jsdom via
// fake-indexeddb instead — see e.g. local-document-summary.test.tsx.
import { Loro } from 'loro-crdt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { seedSyncDocument } from '../test-utils/seed-sync-document.js'
import { IdbDocumentStore } from './idb-document-store.js'
import { loroRecordEnvelopeSchema } from './loro-record-envelope.js'
import { LoroStore } from './loro-store.js'

const ISOLATED_DB = claimIsolatedWhiteboardDb('loro-store')

async function clearDb(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(ISOLATED_DB)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
  })
}

function makeSnapshot(elements: unknown[]): Uint8Array {
  const doc = new Loro()
  const list = doc.getList('elements')
  for (const el of elements) list.push(el)
  return doc.export({ mode: 'snapshot' })
}

describe('loroRecordEnvelopeSchema', () => {
  it('accepts a valid envelope with v:1, snapshot Uint8Array, updatedAt string', () => {
    const envelope = {
      v: 1,
      snapshot: new Uint8Array([1, 2, 3]),
      updatedAt: '2026-06-06T00:00:00.000Z',
    }
    const result = loroRecordEnvelopeSchema.safeParse(envelope)
    expect(result.success).toBe(true)
  })

  it('rejects payload with wrong v', () => {
    const bad = { v: 2, snapshot: new Uint8Array([1]), updatedAt: '2026-01-01T00:00:00Z' }
    expect(loroRecordEnvelopeSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects payload missing snapshot field', () => {
    const bad = { v: 1, updatedAt: '2026-01-01T00:00:00Z' }
    expect(loroRecordEnvelopeSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects payload where snapshot is not a Uint8Array', () => {
    const bad = { v: 1, snapshot: [1, 2, 3], updatedAt: '2026-01-01T00:00:00Z' }
    expect(loroRecordEnvelopeSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects payload missing updatedAt', () => {
    const bad = { v: 1, snapshot: new Uint8Array([1]) }
    expect(loroRecordEnvelopeSchema.safeParse(bad).success).toBe(false)
  })
})

describe('LoroStore (real IndexedDB)', () => {
  beforeEach(async () => {
    await clearDb()
  })
  afterEach(async () => {
    await clearDb()
  })

  it('load returns not-found for unknown documentId', async () => {
    const store = new LoroStore()
    const result = await store.load('unknown-id')
    expect(result).toEqual({ kind: 'not-found' })
  })

  it('createEmptySnapshot returns bytes that import into a fresh Loro doc without throwing', () => {
    const store = new LoroStore()
    const bytes = store.createEmptySnapshot()
    expect(bytes).toBeInstanceOf(Uint8Array)
    const doc = new Loro()
    expect(() => doc.import(bytes)).not.toThrow()
    expect(doc.getList('elements').length).toBe(0)
  })

  it('createEmptySnapshot bytes round-trip through save/load', async () => {
    const store = new LoroStore()
    await store.save('empty-canvas', store.createEmptySnapshot())
    const result = await store.load('empty-canvas')
    expect(result.kind).toBe('ok')
  })

  it('save then load returns ok with the snapshot bytes', async () => {
    const store = new LoroStore()
    const snapshot = makeSnapshot([{ id: 'a', type: 'rect' }])
    await store.save('canvas-1', snapshot)
    const result = await store.load('canvas-1')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.snapshot).toBeInstanceOf(Uint8Array)
      expect(result.snapshot.length).toBeGreaterThan(0)
      // Verify the bytes decode to the same content
      const doc2 = new Loro()
      doc2.import(result.snapshot)
      expect(doc2.getList('elements').toJSON()).toEqual([{ id: 'a', type: 'rect' }])
    }
  })

  it('save then load with deltas returns all deltas in order', async () => {
    const store = new LoroStore()
    const doc = new Loro()
    doc.getList('elements').push({ id: 'a' })
    const snapshot = doc.export({ mode: 'snapshot' })
    const v0 = doc.version()
    doc.getList('elements').push({ id: 'b' })
    const delta1 = doc.export({ mode: 'update', from: v0 })
    const v1 = doc.version()
    doc.getList('elements').push({ id: 'c' })
    const delta2 = doc.export({ mode: 'update', from: v1 })

    await store.save('canvas-1', snapshot)
    await store.appendDelta('canvas-1', delta1)
    await store.appendDelta('canvas-1', delta2)

    const result = await store.load('canvas-1')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.deltas).toHaveLength(2)
      // Replay snapshot + deltas on a fresh doc
      const fresh = new Loro()
      fresh.import(result.snapshot)
      for (const d of result.deltas ?? []) fresh.import(d)
      expect(fresh.getList('elements').toJSON()).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    }
  })

  it('structurally-corrupt record in IDB (unknown v) returns corrupt-snapshot', async () => {
    await seedSyncDocument('bad-canvas', { raw: { v: 99, garbage: true } })

    const store = new LoroStore()
    const result = await store.load('bad-canvas')
    expect(result.kind).toBe('unsupported-version')
  })

  it('structurally-valid envelope with invalid Loro snapshot bytes returns corrupt-snapshot', async () => {
    // A well-formed record carrying bytes that are NOT valid Loro data.
    await seedSyncDocument('bad-bytes-canvas', {
      snapshot: new Uint8Array([0xff, 0xfe, 0x00, 0x01]),
    })

    const store = new LoroStore()
    const result = await store.load('bad-bytes-canvas')
    expect(result.kind).toBe('corrupt-snapshot')
  })

  it('structurally-valid envelope with valid snapshot but invalid delta bytes returns corrupt-delta', async () => {
    const doc = new Loro()
    doc.getList('elements').push({ id: 'a' })
    const snapshot = doc.export({ mode: 'snapshot' })

    await seedSyncDocument('bad-delta-canvas', {
      snapshot,
      deltas: [new Uint8Array([0xff, 0xfe, 0x00, 0x01])],
    })

    const store = new LoroStore()
    const result = await store.load('bad-delta-canvas')
    expect(result.kind).toBe('corrupt-delta')
  })

  it('appendDelta before any save is a no-op (no snapshot yet)', async () => {
    const store = new LoroStore()
    const delta = new Uint8Array([1, 2, 3])
    // Should resolve without throwing — snapshot must exist first
    await expect(store.appendDelta('canvas-99', delta)).resolves.toBeUndefined()
    // load still returns not-found: no record was created
    const result = await store.load('canvas-99')
    expect(result.kind).toBe('not-found')
  })

  it('appendDelta with a corrupt existing record throws so the caller can surface storage-failure', async () => {
    await seedSyncDocument('corrupt-canvas', { raw: { v: 99, garbage: true } })

    const store = new LoroStore()
    const delta = new Uint8Array([1, 2, 3])
    // Corrupt record must not silently swallow the delta — must throw
    await expect(store.appendDelta('corrupt-canvas', delta)).rejects.toThrow()
  })
})

// --- helpers for raw IndexedDB access in tests ---

/**
 * A read that did not COMPLETE is not a claim about the stored bytes.
 *
 * IndexedDB fails transiently for reasons that say nothing about the
 * document — a connection closing under a version change, an aborted
 * transaction, a quota error. Every one of those used to arrive here as
 * `corrupt-snapshot`, which is the sentence this module's own contract
 * forbids: the bytes are there, and telling their owner otherwise is the one
 * thing it must not do. The page then offered "Start fresh", whose only
 * action is to delete the document being reported as damaged.
 */
it('answers read-unavailable when the read itself fails, not corrupt-snapshot', async () => {
  const dbName = `unavailable-${Math.trunc(performance.now() * 1000)}`
  const inner = new IdbDocumentStore(dbName)
  const store = new LoroStore(dbName, {
    ...inner,
    saveSnapshot: (i) => inner.saveSnapshot(i),
    loadDeltas: (i) => inner.loadDeltas(i),
    appendDeltas: (i) => inner.appendDeltas(i),
    readSnapshotManifest: (i) => inner.readSnapshotManifest(i),
    readFrontier: (i) => inner.readFrontier(i),
    deleteDoc: (i) => inner.deleteDoc(i),
    saveCompactedSnapshot: (i) => inner.saveCompactedSnapshot(i),
    loadSnapshot: () => {
      // What the browser throws when a transaction is aborted mid-read. It
      // carries no verdict on the record.
      throw new DOMException('The transaction was aborted', 'AbortError')
    },
  })

  expect((await store.load('doc')).kind).toBe('read-unavailable')
})
