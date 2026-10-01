import { describe, expect, it } from 'vitest'
import { exportRequestSchema } from './export.js'

describe('exportRequestSchema', () => {
  it('accepts an empty object (every field optional)', () => {
    expect(exportRequestSchema.parse({})).toEqual({})
  })

  it('accepts every field populated', () => {
    const input = {
      padding: 16,
      scale: 2,
      outputPath: '/tmp/out.png',
      overwrite: true,
      theme: 'dark' as const,
    }
    expect(exportRequestSchema.parse(input)).toEqual(input)
  })

  it('rejects a non-number padding', () => {
    expect(() => exportRequestSchema.parse({ padding: '16' })).toThrow()
  })

  it('rejects a theme outside the light/dark enum', () => {
    expect(() => exportRequestSchema.parse({ theme: 'sepia' })).toThrow()
  })

  it("accepts style as 'clean', 'document' or a namespaced theme id, and nothing else", () => {
    expect(exportRequestSchema.parse({ style: 'document' })).toEqual({ style: 'document' })
    expect(exportRequestSchema.parse({ style: 'visual.neon' })).toEqual({ style: 'visual.neon' })
    expect(() => exportRequestSchema.parse({ style: 'neon' })).toThrow()
  })

  // Each value is well-typed for the field it once carried, so the refusal
  // is for the field's existence and not for a type mismatch.
  it.each([
    ['minFontPx', 12],
    ['frameId', 'frame-1'],
    ['background', '#fff'],
  ])('refuses the undefined field %s', (field, value) => {
    const parsed = exportRequestSchema.safeParse({ [field]: value })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain(field)
  })
})
