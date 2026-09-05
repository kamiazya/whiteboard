// @vitest-environment node
// Editable-PNG embedding: an exported PNG carries the JSON Canvas document
// in an iTXt chunk (the draw.io pattern), so a shared screenshot IS the
// canvas — exact node coordinates included — not just pixels of it.
import { describe, expect, it } from 'vitest'
import { embedTextInPng, extractTextFromPng } from './png-embed.js'

// Smallest valid PNG (1×1 transparent), from the canonical example bytes.
const TINY_PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  ),
  (c) => c.charCodeAt(0),
)

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function chunkTypes(png: Uint8Array): string[] {
  const types: string[] = []
  let offset = 8
  while (offset + 8 <= png.length) {
    const len =
      ((png[offset]! << 24) |
        (png[offset + 1]! << 16) |
        (png[offset + 2]! << 8) |
        png[offset + 3]!) >>>
      0
    const type = String.fromCharCode(
      png[offset + 4]!,
      png[offset + 5]!,
      png[offset + 6]!,
      png[offset + 7]!,
    )
    types.push(type)
    offset += 12 + len
  }
  return types
}

describe('embedTextInPng', () => {
  it('round-trips arbitrary UTF-8 text under the keyword', () => {
    const json = JSON.stringify({ nodes: [{ id: 'あ', x: -5, y: 12.5 }], edges: [] })
    const out = embedTextInPng(TINY_PNG, 'whiteboard', json)
    expect(extractTextFromPng(out, 'whiteboard')).toBe(json)
  })

  it('keeps the PNG structurally valid: signature intact, chunk walk closes on IEND', () => {
    const out = embedTextInPng(TINY_PNG, 'whiteboard', 'payload')
    expect([...out.slice(0, 8)]).toEqual(PNG_SIGNATURE)
    const types = chunkTypes(out)
    expect(types[0]).toBe('IHDR')
    expect(types[types.length - 1]).toBe('IEND')
    expect(types).toContain('iTXt')
  })

  it('replaces an existing chunk with the same keyword instead of stacking', () => {
    const once = embedTextInPng(TINY_PNG, 'whiteboard', 'first')
    const twice = embedTextInPng(once, 'whiteboard', 'second')
    expect(extractTextFromPng(twice, 'whiteboard')).toBe('second')
    expect(chunkTypes(twice).filter((t) => t === 'iTXt')).toHaveLength(1)
  })

  it('extraction is total: no chunk → null, garbage bytes → null', () => {
    expect(extractTextFromPng(TINY_PNG, 'whiteboard')).toBeNull()
    expect(extractTextFromPng(Uint8Array.from([1, 2, 3]), 'whiteboard')).toBeNull()
  })
})
