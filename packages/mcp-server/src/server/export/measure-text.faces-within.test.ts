import { REGISTER_LAYOUT_FONTS_CAPS } from '@kamiazya/whiteboard-core-wasm'
import { describe, expect, it } from 'vitest'
import { facesWithinRegistration } from './measure-text.js'

const face = (family: string, size: number) => ({
  family,
  bold: false,
  italic: false,
  bytes: new Uint8Array(size),
})

describe('facesWithinRegistration', () => {
  const vendored = [face('Roboto', 100), face('Roboto', 100)]
  const caps = { maxBytes: 4000, maxNodes: 5 }

  it('keeps the vendored faces and every installed family that fits, in order', () => {
    const installed = [face('A', 400), face('B', 400)]
    expect(facesWithinRegistration(vendored, installed, caps).map((f) => f.family)).toEqual([
      'Roboto',
      'Roboto',
      'A',
      'B',
    ])
  })

  it('leaves out a family past the bytes, and still takes a smaller one after it', () => {
    const installed = [face('A', 600), face('Huge', 5000), face('B', 300)]
    const held = facesWithinRegistration(vendored, installed, caps).map((f) => f.family)
    expect(held).toEqual(['Roboto', 'Roboto', 'A', 'B'])
  })

  it('leaves out every family past the count', () => {
    const installed = ['A', 'B', 'C', 'D'].map((family) => face(family, 10))
    const held = facesWithinRegistration(vendored, installed, caps).map((f) => f.family)
    expect(held).toEqual(['Roboto', 'Roboto', 'A', 'B', 'C'])
  })

  it('holds to the registration caps the core declares by default', () => {
    const big = REGISTER_LAYOUT_FONTS_CAPS.maxBytes / 2
    // Two faces of half the cap each cannot both fit beside the vendored ones.
    const installed = [face('A', big), face('B', big)]
    const held = facesWithinRegistration(vendored, installed)
    expect(held.map((f) => f.family)).toEqual(['Roboto', 'Roboto', 'A'])
  })
})
