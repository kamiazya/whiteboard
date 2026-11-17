// The style-randomness stream's contract (decision #10): seeded and pure.
// The seed is the core's hash of a node's id (`seed_from_id`, replayed by
// `node_box_oracle.rs`); geometry is deliberately NOT an input — that is
// what makes styled output invariant under translate/scale and immune to
// edits of unrelated nodes.
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { styleRandomFromSeed } from './seed.js'

/** Every seed a scene node can carry: an unsigned 32-bit integer. */
const seed = () => fc.integer({ min: 0, max: 2 ** 32 - 1 })

describe('a style random stream keyed by a seed', () => {
  fcTest.prop([seed()], withDefaults())(
    'identical seeds replay identical sequences (byte-identical reruns)',
    (s) => {
      const a = styleRandomFromSeed(s)
      const b = styleRandomFromSeed(s)
      for (let i = 0; i < 16; i++) expect(a()).toBe(b())
    },
  )

  fcTest.prop([seed(), seed()], withDefaults())(
    "a node's stream is unaffected by other nodes existing or being consumed",
    (s, other) => {
      const alone = styleRandomFromSeed(s)
      const otherStream = styleRandomFromSeed(other)
      otherStream()
      otherStream()
      const afterOthers = styleRandomFromSeed(s)
      for (let i = 0; i < 8; i++) expect(afterOthers()).toBe(alone())
    },
  )

  fcTest.prop([seed()], withDefaults())('every draw is finite and in [0, 1)', (s) => {
    const random = styleRandomFromSeed(s)
    for (let i = 0; i < 64; i++) {
      const value = random()
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

// The retrieval scoreboard, the routing corpus and the doc screenshots all
// draw from this stream; a change to its sequence silently moves every one.
describe('styleRandomFromSeed sequence', () => {
  it('is the mulberry32 stream for a fixed seed', () => {
    const next = styleRandomFromSeed(0x5eed)
    expect([next(), next(), next()]).toEqual([
      0.7100320369936526, 0.286336648510769, 0.9519026265479624,
    ])
  })
})
