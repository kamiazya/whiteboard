import { describe, expect, it } from 'vitest'
import { exportSvgRequestSchema } from './export-svg.js'

describe('exportSvgRequestSchema', () => {
  it('accepts an empty object (every field optional)', () => {
    expect(exportSvgRequestSchema.parse({})).toEqual({})
  })

  it('accepts every field populated', () => {
    const input = {
      padding: 16,
      outputPath: '/tmp/out.svg',
      overwrite: true,
      theme: 'dark' as const,
    }
    expect(exportSvgRequestSchema.parse(input)).toEqual(input)
  })

  it('rejects a theme outside the light/dark enum', () => {
    expect(() => exportSvgRequestSchema.parse({ theme: 'sepia' })).toThrow()
  })

  // Each value is well-typed for the field it once carried (or, for `scale`,
  // for the PNG request), so the refusal is for the field's existence.
  it.each([
    ['frameId', 'frame-1'],
    ['scale', 2],
    ['background', '#fff'],
  ])('refuses the undefined field %s', (field, value) => {
    const parsed = exportSvgRequestSchema.safeParse({ [field]: value })
    expect(parsed.success).toBe(false)
    expect(JSON.stringify(parsed.error?.issues)).toContain(field)
  })
})
