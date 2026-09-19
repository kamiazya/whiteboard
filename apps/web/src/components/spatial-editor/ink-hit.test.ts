import { describe, expect, it } from 'vitest'
import { inkUnder, inkWithin } from './ink-hit.js'

const straight = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
]
const never = () => false

describe('inkUnder', () => {
  it('answers the ink a press landed within tolerance of', () => {
    const paths = [{ id: 'ink', path: straight, ink: true }]
    expect(inkUnder(paths, { x: 50, y: 4 }, 6, never)?.id).toBe('ink')
    expect(inkUnder(paths, { x: 50, y: 9 }, 6, never)).toBeUndefined()
  })

  it('is blind to an EDGE, however near the press lands', () => {
    // The distinction this module exists to make: an edge is routed around
    // the boxes it connects, so taking the press from a node it passes over
    // would cost more than it buys.
    expect(inkUnder([{ id: 'e', path: straight }], { x: 50, y: 0 }, 6, never)).toBeUndefined()
  })

  it('is blind to LOCKED ink, which is what keeps it out of Delete', () => {
    const paths = [{ id: 'ink', path: straight, ink: true }]
    expect(inkUnder(paths, { x: 50, y: 0 }, 6, (id) => id === 'ink')).toBeUndefined()
  })

  it('measures against the DRAWN path, not the line between its ends', () => {
    // A stroke that went up and came back: the press sits on the peak, which
    // is 60 away from the straight run between the two ends.
    const peak = [
      { x: 0, y: 0 },
      { x: 50, y: 60 },
      { x: 100, y: 0 },
    ]
    expect(inkUnder([{ id: 'ink', path: peak, ink: true }], { x: 50, y: 58 }, 6, never)?.id).toBe(
      'ink',
    )
  })
})

describe('inkWithin', () => {
  const band = { x: 0, y: 0, w: 100, h: 100 }
  const ink = (id: string, path: readonly { x: number; y: number }[]) => ({ id, path, ink: true })

  it('takes ink whose path runs inside the band', () => {
    expect(
      inkWithin(
        [
          ink('a', [
            { x: 10, y: 10 },
            { x: 90, y: 90 },
          ]),
        ],
        band,
        never,
      ),
    ).toEqual(['a'])
  })

  it('takes ink that only CROSSES the band, with no point inside it', () => {
    // The common case a containment test would silently leave behind: a
    // stroke that runs clean through the band and out the other side.
    expect(
      inkWithin(
        [
          ink('a', [
            { x: -50, y: 50 },
            { x: 150, y: 50 },
          ]),
        ],
        band,
        never,
      ),
    ).toEqual(['a'])
  })

  it('leaves ink the band never reached', () => {
    expect(
      inkWithin(
        [
          ink('a', [
            { x: 200, y: 200 },
            { x: 300, y: 300 },
          ]),
        ],
        band,
        never,
      ),
    ).toEqual([])
  })

  it('leaves an EDGE and locked ink alone', () => {
    const crossing = [
      { x: 10, y: 10 },
      { x: 90, y: 90 },
    ]
    expect(inkWithin([{ id: 'e', path: crossing }], band, never)).toEqual([])
    expect(inkWithin([ink('a', crossing)], band, (id) => id === 'a')).toEqual([])
  })
})
