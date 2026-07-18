import { describe, expect, it } from 'vitest'
import { sanitizeExportFilenameBase } from './export-filename'

describe('sanitizeExportFilenameBase', () => {
  it('replaces filesystem-unsafe characters with a hyphen', () => {
    expect(sanitizeExportFilenameBase('a\\b/c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })

  it('leaves an already-safe name untouched', () => {
    expect(sanitizeExportFilenameBase('my-canvas_v2')).toBe('my-canvas_v2')
  })
})
