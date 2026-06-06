/**
 * Loro CRDT round-trip spike (3-B feasibility).
 *
 * These tests validate the LoroDoc API shapes we depend on before committing
 * to the persistence schema. They MUST run in a real browser context because
 * loro-crdt ships a WASM binary that jsdom cannot host.
 */
import { describe, expect, it } from 'vitest'
import { Loro } from 'loro-crdt'

describe('Loro snapshot round-trip', () => {
  it('exports a non-empty Uint8Array snapshot and imports it into a fresh doc', () => {
    const input = [
      { id: 'a', type: 'rect', x: 1 },
      { id: 'b', type: 'text', x: 2 },
    ]

    const doc = new Loro()
    const elements = doc.getList('elements')
    for (const el of input) {
      elements.push(el)
    }

    const snapshot = doc.export({ mode: 'snapshot' })

    expect(snapshot).toBeInstanceOf(Uint8Array)
    expect(snapshot.length).toBeGreaterThan(0)

    const doc2 = new Loro()
    doc2.import(snapshot)
    const decoded = doc2.getList('elements').toJSON()
    expect(decoded).toEqual(input)
  })

  it('exports a non-empty delta and importing snapshot+delta into a fresh doc equals post-mutation state', () => {
    const initial = [{ id: 'a', type: 'rect', x: 1 }]
    const postMutation = [{ id: 'a', type: 'rect', x: 1 }, { id: 'c', type: 'ellipse', x: 5 }]

    const doc = new Loro()
    const elements = doc.getList('elements')
    elements.push(initial[0])

    const snapshot = doc.export({ mode: 'snapshot' })
    const versionAfterSnapshot = doc.version()

    // Mutation after snapshot
    elements.push({ id: 'c', type: 'ellipse', x: 5 })

    const delta = doc.export({ mode: 'update', from: versionAfterSnapshot })

    expect(delta).toBeInstanceOf(Uint8Array)
    expect(delta.length).toBeGreaterThan(0)
    // Delta bytes differ from snapshot bytes
    expect(Array.from(delta)).not.toEqual(Array.from(snapshot))

    // Replay on a fresh doc
    const doc3 = new Loro()
    doc3.import(snapshot)
    doc3.import(delta)
    const decoded = doc3.getList('elements').toJSON()
    expect(decoded).toEqual(postMutation)
  })
})

describe('Loro error paths', () => {
  it('importing corrupt bytes throws', () => {
    const doc = new Loro()
    const corrupt = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xde, 0xad, 0xbe, 0xef])
    expect(() => doc.import(corrupt)).toThrow()
  })

  it('empty bytes are NOT imported (zero-length Uint8Array treated as no-data)', () => {
    // Zero-length import should either be a no-op or throw — either way it
    // must not silently corrupt the doc state. We assert the doc is still
    // usable (getList round-trip still works) after the call attempt.
    const doc = new Loro()
    const empty = new Uint8Array(0)
    // It may throw or silently no-op; either is acceptable here.
    try {
      doc.import(empty)
    } catch {
      // expected
    }
    // Doc is still usable
    doc.getList('elements').push({ id: 'x' })
    expect(doc.getList('elements').toJSON()).toEqual([{ id: 'x' }])
  })
})
