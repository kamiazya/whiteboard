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
      minFontPx: 12,
      frameId: 'frame-1',
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
})
