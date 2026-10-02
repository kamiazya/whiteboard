import type { Embedder } from '../search/embedder.js'

const FAKE_DIMENSIONS = 8

/**
 * A deterministic embedder whose vectors are unit-norm by construction: a
 * bag of character codes folded into a fixed width, then normalised. Not a
 * model — it exists so a test can hold the port's contract without one.
 */
export function createFakeEmbedder(): Embedder {
  return {
    id: 'fake-hash@v1',
    dimensions: FAKE_DIMENSIONS,
    async embed(texts) {
      return texts.map((text) => {
        const vector = new Float32Array(FAKE_DIMENSIONS)
        for (const char of text) {
          const slot = (char.codePointAt(0) ?? 0) % FAKE_DIMENSIONS
          vector[slot] = (vector[slot] ?? 0) + 1
        }
        const length = Math.hypot(...vector)
        // An empty text folds to nothing; the port still owes it a unit vector.
        if (length === 0) vector[0] = 1
        return length === 0 ? vector : vector.map((component) => component / length)
      })
    },
  }
}
