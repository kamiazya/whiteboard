import { describe, expect, it } from 'vitest'
import { canvasIdSchema, nodeIdSchema, workspaceIdSchema } from './ids.js'

describe('canvasIdSchema', () => {
  it('accepts a canonical 26-char ULID starting with 0-7', () => {
    expect(canvasIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true)
    expect(canvasIdSchema.safeParse('7ZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(true)
  })

  it('rejects a string that is 25 or 27 characters long', () => {
    expect(canvasIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FA').success).toBe(false)
    expect(canvasIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAVX').success).toBe(false)
  })

  it('rejects Crockford-excluded characters I, L, O, U', () => {
    expect(canvasIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAI').success).toBe(false)
    expect(canvasIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAL').success).toBe(false)
    expect(canvasIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAO').success).toBe(false)
    expect(canvasIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAU').success).toBe(false)
  })

  it('rejects a first character outside 0-7 (128-bit overflow constraint)', () => {
    expect(canvasIdSchema.safeParse('8ZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(false)
    expect(canvasIdSchema.safeParse('ZZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(false)
  })
})

describe('nodeIdSchema', () => {
  it('accepts any non-empty string (nanoid convention, charset not enforced)', () => {
    expect(nodeIdSchema.safeParse('V1StGXR8_Z5jdHi6B-myT').success).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(nodeIdSchema.safeParse('').success).toBe(false)
  })
})

describe('workspaceIdSchema', () => {
  it('accepts existing path-safe-slug workspace ids used across the codebase', () => {
    for (const id of ['workspace-a', 'ws_main', 'session-1', 'sid', 'M7lgM0WguBnkfP_1iOFtY']) {
      expect(workspaceIdSchema.safeParse(id).success).toBe(true)
    }
  })

  it('rejects an empty string', () => {
    expect(workspaceIdSchema.safeParse('').success).toBe(false)
  })

  it('rejects path-traversal and path-separator characters', () => {
    expect(workspaceIdSchema.safeParse('../escape').success).toBe(false)
    expect(workspaceIdSchema.safeParse('a/b').success).toBe(false)
  })

  it('rejects dots and whitespace', () => {
    expect(workspaceIdSchema.safeParse('a.b').success).toBe(false)
    expect(workspaceIdSchema.safeParse(' ws').success).toBe(false)
  })

  it('rejects non-ASCII characters', () => {
    expect(workspaceIdSchema.safeParse('wsé').success).toBe(false)
  })
})
