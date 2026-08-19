import { documentIdSchema } from '@kamiazya/whiteboard-model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateDocumentId } from './generate-document-id.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('generateDocumentId', () => {
  it('produces a 26-character string matching documentIdSchema', () => {
    const id = generateDocumentId()
    expect(id).toHaveLength(26)
    expect(() => documentIdSchema.parse(id)).not.toThrow()
  })

  it('produces different ids on consecutive calls', () => {
    const first = generateDocumentId()
    const second = generateDocumentId()
    expect(first).not.toBe(second)
  })

  // The entropy source is the point, not an implementation detail. A
  // predictable id is only harmless while nothing treats knowing one as
  // permission to read it — and "anyone with the link" is the feature every
  // product of this shape eventually grows.
  it('draws its entropy from the CSPRNG, never from Math.random', () => {
    const random = vi.spyOn(Math, 'random')
    const getRandomValues = vi.spyOn(globalThis.crypto, 'getRandomValues')

    generateDocumentId()

    expect(random).not.toHaveBeenCalled()
    // The QUANTITY is the point, not just the source: one byte per character.
    // Asking for four and stretching them across sixteen characters would
    // keep the source check green while dropping 80 bits of entropy to 32.
    const [bytes] = getRandomValues.mock.calls[0] ?? []
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).toHaveLength(16)
  })

  // 256 is a whole multiple of the 32-character alphabet, so a byte taken
  // modulo it is uniform. The same code over a 26- or 36-character alphabet
  // would quietly favour its first letters.
  //
  // The fixture is chosen so a WRONG modulus collides and the right one does
  // not: 0 and 26 differ mod 32 and are equal mod 26. Plain 0,1,2,… would
  // land on distinct letters under either and prove nothing.
  it('maps bytes onto the alphabet without bias', () => {
    const seeded = [0, 26, 1, 27, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
      const bytes = array as Uint8Array
      for (let i = 0; i < bytes.length; i++) bytes[i] = seeded[i] as number
      return array
    })

    const random = generateDocumentId().slice(10)
    expect(new Set(random).size).toBe(random.length)
  })

  // The first ten characters are a millisecond clock, which is what makes an
  // id sortable and gives a database inserting them index locality.
  it('keeps the time prefix ordered', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000)
    const earlier = generateDocumentId().slice(0, 10)
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000_001_000)
    const later = generateDocumentId().slice(0, 10)

    expect(earlier < later).toBe(true)
  })
})
