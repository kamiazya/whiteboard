import { describe, expect, it } from 'vitest'
import { DERIVED_KEY_BITS, PRF_OUTPUT_BYTES } from './key-widths.js'
import { deriveDocumentKey, deriveDocumentKeyBytes } from './read-plane.js'
import { deriveWrappingKey } from './replica-key-wrap.js'

// Both modules read their key width from key-widths, so what each produces has
// to be the width it names: a module going back to its own literal fails here.
describe('the widths the read plane and the wrap share', () => {
  const context = {
    workspaceKey: new Uint8Array(32).fill(1),
    workspaceKeySalt: new Uint8Array(16).fill(2),
    documentId: 'doc',
    epoch: 0,
  }

  it('derive document keys and wrapping keys of the one declared width', async () => {
    expect((await deriveDocumentKeyBytes(context)).length * 8).toBe(DERIVED_KEY_BITS)
    expect(((await deriveDocumentKey(context)).algorithm as AesKeyAlgorithm).length).toBe(
      DERIVED_KEY_BITS,
    )
    const wrapping = await deriveWrappingKey(new Uint8Array(PRF_OUTPUT_BYTES).fill(7))
    expect((wrapping.algorithm as AesKeyAlgorithm).length).toBe(DERIVED_KEY_BITS)
  })

  it('refuses a prf output of any other width at the wrap', async () => {
    for (const width of [PRF_OUTPUT_BYTES - 1, PRF_OUTPUT_BYTES + 1]) {
      await expect(deriveWrappingKey(new Uint8Array(width))).rejects.toThrow(RangeError)
    }
  })
})
