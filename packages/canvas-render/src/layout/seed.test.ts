// The style-randomness primitive's contract (decision #10): seeded,
// id-keyed, and pure. Geometry is deliberately NOT an input — that is
// what makes styled output invariant under translate/scale and immune to
// edits of unrelated nodes.
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import { createStyleRandom, seedFromId } from './seed.js'

describe('seedFromId', () => {
  fcTest.prop([fc.string()], withDefaults())('is a pure function of the id', (id) => {
    expect(seedFromId(id)).toBe(seedFromId(id))
  })

  fcTest.prop([fc.string()], withDefaults())(
    'always yields a finite 32-bit unsigned integer, any input',
    (id) => {
      const seed = seedFromId(id)
      expect(Number.isInteger(seed)).toBe(true)
      expect(seed).toBeGreaterThanOrEqual(0)
      expect(seed).toBeLessThan(2 ** 32)
    },
  )

  it('separates nearby ids (no trivial collisions on suffix counters)', () => {
    const seeds = new Set(Array.from({ length: 1000 }, (_, i) => seedFromId(`node-${i}`)))
    expect(seeds.size).toBe(1000)
  })

  it('a salt derives an independent stream identity from the same id', () => {
    expect(seedFromId('n1', 'outline')).not.toBe(seedFromId('n1', 'fill'))
    expect(seedFromId('n1', 'outline')).toBe(seedFromId('n1', 'outline'))
  })
})

describe('createStyleRandom', () => {
  fcTest.prop([fc.string()], withDefaults())(
    'identical ids replay identical sequences (byte-identical reruns)',
    (id) => {
      const a = createStyleRandom(id)
      const b = createStyleRandom(id)
      for (let i = 0; i < 16; i++) expect(a()).toBe(b())
    },
  )

  fcTest.prop([fc.string(), fc.string()], withDefaults())(
    "a node's stream is unaffected by other nodes existing or being consumed",
    (id, other) => {
      const alone = createStyleRandom(id)
      const otherStream = createStyleRandom(other)
      otherStream()
      otherStream()
      const afterOthers = createStyleRandom(id)
      for (let i = 0; i < 8; i++) expect(afterOthers()).toBe(alone())
    },
  )

  fcTest.prop([fc.string()], withDefaults())('every draw is finite and in [0, 1)', (id) => {
    const random = createStyleRandom(id)
    for (let i = 0; i < 64; i++) {
      const value = random()
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
