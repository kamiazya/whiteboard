import { afterEach, describe, expect, it } from 'vitest'
import { readViewport, writeViewport } from './viewport-memory.js'

afterEach(() => sessionStorage.clear())

describe('viewport memory', () => {
  it('gives back what was written for the same document', () => {
    writeViewport('doc-a', { x: 120, y: -40, zoom: 2 })
    expect(readViewport('doc-a')).toEqual({ x: 120, y: -40, zoom: 2 })
  })

  it('keeps one position per document', () => {
    writeViewport('doc-a', { x: 1, y: 2, zoom: 1 })
    expect(readViewport('doc-b')).toBeNull()
  })

  it('reads a damaged or foreign entry as nothing remembered', () => {
    sessionStorage.setItem('wb.viewport:doc-a', '{"x":"left"}')
    expect(readViewport('doc-a')).toBeNull()
    sessionStorage.setItem('wb.viewport:doc-a', 'not json')
    expect(readViewport('doc-a')).toBeNull()
  })

  it('clamps a remembered zoom into the supported range', () => {
    writeViewport('doc-a', { x: 0, y: 0, zoom: 1e9 })
    expect(readViewport('doc-a')?.zoom).toBeLessThan(1e9)
  })
})
