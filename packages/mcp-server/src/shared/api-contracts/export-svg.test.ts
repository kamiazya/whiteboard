import { describe, expect, it } from 'vitest'
import { exportSvgRequestSchema } from './export-svg.js'

describe('exportSvgRequestSchema', () => {
  it('accepts an empty object (every field optional)', () => {
    expect(exportSvgRequestSchema.parse({})).toEqual({})
  })

  it('accepts every field populated', () => {
    const input = {
      padding: 16,
      frameId: 'frame-1',
      outputPath: '/tmp/out.svg',
      overwrite: true,
      theme: 'dark' as const,
    }
    expect(exportSvgRequestSchema.parse(input)).toEqual(input)
  })

  it('rejects a non-string frameId', () => {
    expect(() => exportSvgRequestSchema.parse({ frameId: 42 })).toThrow()
  })

  it('rejects a theme outside the light/dark enum', () => {
    expect(() => exportSvgRequestSchema.parse({ theme: 'sepia' })).toThrow()
  })

  it('has no scale field (vector output is resolution-independent)', () => {
    expect(exportSvgRequestSchema.parse({ scale: 2 })).toEqual({})
  })
})
