import { describe, expect, it } from 'vitest'
import {
  documentIdSchema,
  nodeIdSchema,
  workspaceCanonicalIdSchema,
  workspaceDisplayNameSchema,
  workspaceIdSchema,
  workspaceSegmentSchema,
} from './ids.js'

describe('documentIdSchema', () => {
  it('accepts a canonical 26-char ULID starting with 0-7', () => {
    expect(documentIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true)
    expect(documentIdSchema.safeParse('7ZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(true)
  })

  it('rejects a string that is 25 or 27 characters long', () => {
    expect(documentIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FA').success).toBe(false)
    expect(documentIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAVX').success).toBe(false)
  })

  it('rejects Crockford-excluded characters I, L, O, U', () => {
    expect(documentIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAI').success).toBe(false)
    expect(documentIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAL').success).toBe(false)
    expect(documentIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAO').success).toBe(false)
    expect(documentIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAU').success).toBe(false)
  })

  it('rejects a first character outside 0-7 (128-bit overflow constraint)', () => {
    expect(documentIdSchema.safeParse('8ZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(false)
    expect(documentIdSchema.safeParse('ZZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(false)
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
  it('accepts existing path-safe-path workspace ids used across the codebase', () => {
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

describe('workspaceCanonicalIdSchema', () => {
  it('accepts a canonical 26-char ULID starting with 0-7', () => {
    expect(workspaceCanonicalIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(true)
    expect(workspaceCanonicalIdSchema.safeParse('7ZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(true)
  })

  it('rejects a string that is 25 or 27 characters long', () => {
    expect(workspaceCanonicalIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FA').success).toBe(false)
    expect(workspaceCanonicalIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAVX').success).toBe(false)
  })

  it('rejects Crockford-excluded characters I, L, O, U', () => {
    expect(workspaceCanonicalIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAI').success).toBe(false)
    expect(workspaceCanonicalIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAL').success).toBe(false)
    expect(workspaceCanonicalIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAO').success).toBe(false)
    expect(workspaceCanonicalIdSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAU').success).toBe(false)
  })

  it('rejects a first character outside 0-7 (128-bit overflow constraint)', () => {
    expect(workspaceCanonicalIdSchema.safeParse('8ZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(false)
    expect(workspaceCanonicalIdSchema.safeParse('ZZZZZZZZZZZZZZZZZZZZZZZZZZ').success).toBe(false)
  })
})

describe('workspaceSegmentSchema', () => {
  // The load-bearing invariant (ADR-0019): URLs resolve segment-first with
  // canonical-id fallback in one position, so a segment must never itself
  // be shaped like a ULID — case-insensitively, since Crockford base32
  // decodes without regard to case.
  it('rejects a canonical-ULID-shaped string, uppercase or lowercase', () => {
    expect(workspaceSegmentSchema.safeParse('01ARZ3NDEKTSV4RRFFQ69G5FAV').success).toBe(false)
    expect(workspaceSegmentSchema.safeParse('01arz3ndektsv4rrffq69g5fav').success).toBe(false)
  })

  it('accepts a 26-char string that cannot be a ULID (contains an excluded Crockford letter)', () => {
    expect(workspaceSegmentSchema.safeParse('ll0123456789abcdefghijklmn').success).toBe(true)
  })

  it('accepts 25- and 27-char alphanumeric strings (ULID shape requires exactly 26)', () => {
    expect(workspaceSegmentSchema.safeParse('a123456789abcdefghijklmno').success).toBe(true)
    expect(workspaceSegmentSchema.safeParse('a123456789abcdefghijklmnopq').success).toBe(true)
  })

  it('accepts ordinary segments', () => {
    expect(workspaceSegmentSchema.safeParse('my-notes').success).toBe(true)
    expect(workspaceSegmentSchema.safeParse('a').success).toBe(true)
    expect(workspaceSegmentSchema.safeParse('Team-2').success).toBe(true)
  })

  it('rejects empty, leading/trailing hyphen, and interior-only-invalid punctuation', () => {
    expect(workspaceSegmentSchema.safeParse('').success).toBe(false)
    expect(workspaceSegmentSchema.safeParse('-lead').success).toBe(false)
    expect(workspaceSegmentSchema.safeParse('trail-').success).toBe(false)
    expect(workspaceSegmentSchema.safeParse('a.b').success).toBe(false)
    expect(workspaceSegmentSchema.safeParse('a/b').success).toBe(false)
  })

  it('rejects whitespace and non-ASCII', () => {
    expect(workspaceSegmentSchema.safeParse(' x').success).toBe(false)
    expect(workspaceSegmentSchema.safeParse('wsé').success).toBe(false)
  })
})

describe('workspaceDisplayNameSchema', () => {
  it('accepts free text, including spaces and CJK', () => {
    expect(workspaceDisplayNameSchema.safeParse('My Notes').success).toBe(true)
    expect(workspaceDisplayNameSchema.safeParse('プロジェクト').success).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(workspaceDisplayNameSchema.safeParse('').success).toBe(false)
  })

  it('rejects a whitespace-only string', () => {
    expect(workspaceDisplayNameSchema.safeParse('  ').success).toBe(false)
  })

  it('rejects an untrimmed string', () => {
    expect(workspaceDisplayNameSchema.safeParse(' x ').success).toBe(false)
  })
})
