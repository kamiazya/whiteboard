import { describe, expect, it } from 'vitest'
import { CANVAS_SCHEMA_VERSION, canvasKindSchema, canvasMetaSchema } from './meta.js'

describe('canvasKindSchema', () => {
  it('accepts spatial and markdown', () => {
    expect(canvasKindSchema.safeParse('spatial').success).toBe(true)
    expect(canvasKindSchema.safeParse('markdown').success).toBe(true)
  })

  it('rejects an unknown kind', () => {
    expect(canvasKindSchema.safeParse('html').success).toBe(false)
  })
})

describe('canvasMetaSchema', () => {
  it('accepts a markdown canvas meta at the current schema version', () => {
    const result = canvasMetaSchema.safeParse({
      format: 'markdown',
      schemaVersion: CANVAS_SCHEMA_VERSION,
    })
    expect(result.success).toBe(true)
  })

  it('accepts a spatial canvas meta', () => {
    expect(canvasMetaSchema.safeParse({ format: 'spatial', schemaVersion: 1 }).success).toBe(true)
  })

  it('rejects an unknown format', () => {
    expect(canvasMetaSchema.safeParse({ format: 'html', schemaVersion: 1 }).success).toBe(false)
  })

  it('rejects a missing schemaVersion', () => {
    expect(canvasMetaSchema.safeParse({ format: 'markdown' }).success).toBe(false)
  })

  it('rejects any schemaVersion other than the pinned literal 1', () => {
    expect(canvasMetaSchema.safeParse({ format: 'markdown', schemaVersion: 0 }).success).toBe(false)
    expect(canvasMetaSchema.safeParse({ format: 'markdown', schemaVersion: 2 }).success).toBe(false)
    expect(canvasMetaSchema.safeParse({ format: 'markdown', schemaVersion: '1' }).success).toBe(
      false,
    )
  })
})
