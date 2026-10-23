import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { glyphIcon } from './glyph.js'

afterEach(cleanup)

const draw = (name: 'circle' | 'octagon') => {
  const { container } = render(<>{glyphIcon({ kind: 'shape', name })}</>)
  return container
}

it('the octagon glyph is eight straight edges, not the circle in rounded corners', () => {
  const octagon = draw('octagon')
  const points = octagon.querySelector('polygon')?.getAttribute('points')?.trim().split(/\s+/)
  // Sixteen numbers are eight vertices.
  expect(points).toHaveLength(16)
  expect(octagon.innerHTML).not.toBe(draw('circle').innerHTML)
})
