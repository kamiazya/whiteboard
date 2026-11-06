import { expect, it } from 'vitest'
import type { Box } from './geometry.js'
import { nextInRow } from './row-placement.js'

const size = { width: 320, height: 200 }
const grow = (box: Box, gap: number): Box => ({
  x: box.x - gap,
  y: box.y - gap,
  width: box.width + gap * 2,
  height: box.height + gap * 2,
})

it('the next box goes right of the row, on its top line, a gap clear', () => {
  const a = { x: 100, y: 100, width: 320, height: 200 }
  const b = { x: 452, y: 100, width: 320, height: 200 }
  const spot = nextInRow({
    peers: [a, b],
    size,
    obstacles: [a, b].map((box) => grow(box, 32)),
    visible: { x: 0, y: 0, width: 1400, height: 800 },
    gap: 32,
    rowGap: 82,
  })
  expect(spot).toEqual({ x: 804, y: 100 })
})

it('a row whose right would leave the view wraps below its left end', () => {
  const a = { x: 100, y: 100, width: 320, height: 200 }
  const b = { x: 452, y: 100, width: 320, height: 200 }
  const spot = nextInRow({
    peers: [a, b],
    size,
    obstacles: [a, b].map((box) => grow(box, 32)),
    visible: { x: 0, y: 0, width: 1000, height: 800 },
    gap: 32,
    rowGap: 82,
  })
  expect(spot).toEqual({ x: 100, y: 382 })
})

it('something in the way along the row is stepped past, never landed on', () => {
  const a = { x: 100, y: 100, width: 320, height: 200 }
  const note = { x: 460, y: 150, width: 200, height: 100 }
  const spot = nextInRow({
    peers: [a],
    size,
    obstacles: [a, note].map((box) => grow(box, 32)),
    visible: { x: 0, y: 0, width: 1400, height: 800 },
    gap: 32,
    rowGap: 82,
  })
  expect(spot).toEqual({ x: 692, y: 100 })
})

it('with no room on screen either way the row goes on, to be panned to', () => {
  const a = { x: 100, y: 100, width: 320, height: 200 }
  const spot = nextInRow({
    peers: [a],
    size,
    obstacles: [grow(a, 32)],
    visible: { x: 0, y: 0, width: 500, height: 320 },
    gap: 32,
    rowGap: 82,
  })
  expect(spot).toEqual({ x: 452, y: 100 })
})
