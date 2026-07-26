import { describe, expect, it } from 'vitest'
import {
  appendDeltasInputSchema,
  appendDeltasResultSchema,
  loadDeltasInputSchema,
  loadDeltasResultSchema,
  loadSnapshotInputSchema,
  loadSnapshotResultSchema,
  readFrontierInputSchema,
  readFrontierResultSchema,
  saveSnapshotInputSchema,
} from './canvas-doc-store.js'

const docRef = { kind: 'canvas' as const, canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }
const frontier = new Uint8Array([1])
const manifest = { chunkCount: 0, totalBytes: 0, maxChunkBytes: 4 }

describe('CanvasDocStore method DTOs', () => {
  it('loadSnapshot: accepts a docRef input; result accepts null and a populated payload', () => {
    expect(loadSnapshotInputSchema.safeParse({ docRef }).success).toBe(true)
    expect(loadSnapshotInputSchema.safeParse({}).success).toBe(false)
    expect(loadSnapshotResultSchema.safeParse(null).success).toBe(true)
    expect(loadSnapshotResultSchema.safeParse({ manifest, chunks: [], frontier }).success).toBe(
      true,
    )
  })

  it('saveSnapshot: accepts a full payload and rejects a missing frontier', () => {
    expect(
      saveSnapshotInputSchema.safeParse({ docRef, manifest, chunks: [], frontier }).success,
    ).toBe(true)
    expect(saveSnapshotInputSchema.safeParse({ docRef, manifest, chunks: [] }).success).toBe(false)
  })

  it('appendDeltas: accepts a docRef + deltaBatch input; result requires a frontier', () => {
    expect(
      appendDeltasInputSchema.safeParse({
        docRef,
        deltaBatch: { updates: [new Uint8Array([1])], newFrontier: frontier },
      }).success,
    ).toBe(true)
    expect(appendDeltasResultSchema.safeParse({ frontier }).success).toBe(true)
    expect(appendDeltasResultSchema.safeParse({}).success).toBe(false)
  })

  it('loadDeltas: accepts a docRef + sinceFrontier input; result requires updates + frontier', () => {
    expect(loadDeltasInputSchema.safeParse({ docRef, sinceFrontier: frontier }).success).toBe(true)
    expect(loadDeltasResultSchema.safeParse({ updates: [], frontier }).success).toBe(true)
    expect(loadDeltasResultSchema.safeParse({ updates: [] }).success).toBe(false)
  })

  it('readFrontier: accepts a docRef input; result accepts null and a frontier payload', () => {
    expect(readFrontierInputSchema.safeParse({ docRef }).success).toBe(true)
    expect(readFrontierResultSchema.safeParse(null).success).toBe(true)
    expect(readFrontierResultSchema.safeParse({ frontier }).success).toBe(true)
  })
})
