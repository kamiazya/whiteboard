/**
 * What every `Embedder` must satisfy, written once and run against each
 * implementation.
 *
 * The port promises L2-normalised vectors so a dot product IS the cosine
 * similarity, and `rankByVector` leans on it without checking. An embedder
 * that returns raw model output ranks by magnitude as well as direction —
 * every score still looks plausible and nothing throws, so only a contract
 * run per implementation can say the promise was kept.
 */
import { describe, expect, it } from 'vitest'
import type { Embedder } from '../search/embedder.js'

/** Float32 accumulation over a few hundred components stays well inside this. */
const UNIT_NORM_TOLERANCE = 1e-4

function norm(vector: Float32Array): number {
  let sum = 0
  for (const component of vector) sum += component * component
  return Math.sqrt(sum)
}

export function embedderContract(label: string, makeEmbedder: () => Embedder): void {
  describe(`${label} satisfies the Embedder contract`, () => {
    it.each([
      'query',
      'document',
    ] as const)('returns one unit-norm vector per %s text, in order', async (role) => {
      const embedder = makeEmbedder()
      const texts = ['reconnect', 'storage quota', '初回のオンボーディング']

      const vectors = await embedder.embed(texts, role)

      expect(vectors).toHaveLength(texts.length)
      for (const vector of vectors) {
        expect(vector).toHaveLength(embedder.dimensions)
        expect(Math.abs(norm(vector) - 1)).toBeLessThan(UNIT_NORM_TOLERANCE)
      }
    })

    it('gives an empty text a unit vector too, not a zero one', async () => {
      const embedder = makeEmbedder()
      const [vector] = await embedder.embed([''], 'document')
      expect(vector).toHaveLength(embedder.dimensions)
      expect(Math.abs(norm(vector as Float32Array) - 1)).toBeLessThan(UNIT_NORM_TOLERANCE)
    })

    it('answers nothing for an empty batch', async () => {
      expect(await makeEmbedder().embed([], 'document')).toEqual([])
    })

    it('names what produced its vectors', () => {
      expect(makeEmbedder().id).not.toBe('')
    })
  })
}
