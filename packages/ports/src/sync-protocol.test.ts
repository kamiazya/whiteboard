import { describe, expect, it } from 'vitest'
import { syncMessageSchema } from './sync-protocol.js'

const canvasRef = {
  kind: 'document' as const,
  workspaceId: 'workspace-a',
  documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
}
const frontier = new Uint8Array([1])

describe('syncMessageSchema', () => {
  it('accepts a valid hello', () => {
    expect(syncMessageSchema.safeParse({ type: 'hello', protocolVersions: [1, 2] }).success).toBe(
      true,
    )
  })

  it('accepts a valid welcome', () => {
    expect(syncMessageSchema.safeParse({ type: 'welcome', protocolVersion: 2 }).success).toBe(true)
  })

  it('accepts a valid resume', () => {
    expect(
      syncMessageSchema.safeParse({ type: 'resume', docRef: canvasRef, frontier }).success,
    ).toBe(true)
  })

  it('accepts a valid catchUp carrying docRef', () => {
    const result = syncMessageSchema.safeParse({
      type: 'catchUp',
      docRef: canvasRef,
      updates: [new Uint8Array([1])],
      newFrontier: frontier,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a valid update', () => {
    const result = syncMessageSchema.safeParse({
      type: 'update',
      docRef: canvasRef,
      update: new Uint8Array([2]),
      frontier,
    })
    expect(result.success).toBe(true)
  })

  it('rejects resume/catchUp/update missing docRef', () => {
    expect(syncMessageSchema.safeParse({ type: 'resume', frontier }).success).toBe(false)
    expect(
      syncMessageSchema.safeParse({
        type: 'catchUp',
        updates: [new Uint8Array([1])],
        newFrontier: frontier,
      }).success,
    ).toBe(false)
    expect(
      syncMessageSchema.safeParse({ type: 'update', update: new Uint8Array([2]), frontier })
        .success,
    ).toBe(false)
  })

  it('rejects hello missing protocolVersions and welcome missing protocolVersion', () => {
    expect(syncMessageSchema.safeParse({ type: 'hello' }).success).toBe(false)
    expect(syncMessageSchema.safeParse({ type: 'welcome' }).success).toBe(false)
  })

  it('rejects a version field present on resume/catchUp/update (strict, only hello/welcome carry versions)', () => {
    expect(
      syncMessageSchema.safeParse({
        type: 'resume',
        docRef: canvasRef,
        frontier,
        protocolVersion: 1,
      }).success,
    ).toBe(false)
    expect(
      syncMessageSchema.safeParse({
        type: 'catchUp',
        docRef: canvasRef,
        updates: [new Uint8Array([1])],
        newFrontier: frontier,
        protocolVersions: [1],
      }).success,
    ).toBe(false)
    expect(
      syncMessageSchema.safeParse({
        type: 'update',
        docRef: canvasRef,
        update: new Uint8Array([2]),
        frontier,
        protocolVersion: 1,
      }).success,
    ).toBe(false)
  })

  it('rejects a malformed frontier on resume', () => {
    expect(
      syncMessageSchema.safeParse({ type: 'resume', docRef: canvasRef, frontier: 'abc' }).success,
    ).toBe(false)
  })

  it('rejects a malformed newFrontier on catchUp', () => {
    expect(
      syncMessageSchema.safeParse({
        type: 'catchUp',
        docRef: canvasRef,
        updates: [new Uint8Array([1])],
        newFrontier: 'abc',
      }).success,
    ).toBe(false)
  })

  it('rejects a malformed frontier on update', () => {
    expect(
      syncMessageSchema.safeParse({
        type: 'update',
        docRef: canvasRef,
        update: new Uint8Array([2]),
        frontier: 'abc',
      }).success,
    ).toBe(false)
  })

  it('rejects a catchUp updates element that is not a Uint8Array', () => {
    expect(
      syncMessageSchema.safeParse({
        type: 'catchUp',
        docRef: canvasRef,
        updates: ['x'],
        newFrontier: frontier,
      }).success,
    ).toBe(false)
  })

  it('rejects an update.update that is not a Uint8Array', () => {
    expect(
      syncMessageSchema.safeParse({ type: 'update', docRef: canvasRef, update: 'x', frontier })
        .success,
    ).toBe(false)
  })

  it('rejects an unknown message type', () => {
    expect(syncMessageSchema.safeParse({ type: 'ping' }).success).toBe(false)
  })
})
