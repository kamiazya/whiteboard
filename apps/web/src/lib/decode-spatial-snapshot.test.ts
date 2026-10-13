// lazy-import: each case loads the module fresh under its own mock of loro-crdt.
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('loro-crdt')
  vi.resetModules()
})

describe('decodeSpatialSnapshot', () => {
  it('loads the decoder again after a load that failed', async () => {
    let attempts = 0
    vi.doMock('loro-crdt', async (importOriginal) => {
      attempts += 1
      if (attempts === 1) throw new Error('chunk failed to load')
      return importOriginal()
    })
    const { decodeSpatialSnapshot } = await import('./decode-spatial-snapshot.js')
    await expect(decodeSpatialSnapshot(new Uint8Array())).rejects.toThrow()
    const { LoroDoc } = await vi.importActual<typeof import('loro-crdt')>('loro-crdt')
    const empty = new LoroDoc().export({ mode: 'snapshot' })
    vi.resetModules()
    await expect(decodeSpatialSnapshot(empty)).resolves.toBeDefined()
    expect(attempts).toBe(2)
  })
})
