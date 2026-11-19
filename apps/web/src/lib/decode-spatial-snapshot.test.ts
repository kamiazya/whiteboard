// lazy-import: the case loads the module fresh under its own mock of loro-crdt.
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('loro-crdt')
  vi.doUnmock('@kamiazya/whiteboard-loro-adapter')
  vi.resetModules()
})

describe('decodeSpatialSnapshot', () => {
  it('loads the decoder again after a load that failed', async () => {
    const { LoroDoc } = await vi.importActual<typeof import('loro-crdt')>('loro-crdt')
    const empty = new LoroDoc().export({ mode: 'snapshot' })
    let failNext = true
    vi.doMock('loro-crdt', async (importOriginal) => {
      if (failNext) {
        failNext = false
        throw new Error('chunk failed to load')
      }
      return importOriginal()
    })
    const { decodeSpatialSnapshot } = await import('./decode-spatial-snapshot.js')
    await expect(decodeSpatialSnapshot(empty)).rejects.toThrow()
    vi.resetModules()
    await expect(decodeSpatialSnapshot(empty)).resolves.toBeDefined()
  })

  it('asks for the engine again after the adapter loaded but the engine did not', async () => {
    const { LoroDoc } = await vi.importActual<typeof import('loro-crdt')>('loro-crdt')
    const empty = new LoroDoc().export({ mode: 'snapshot' })
    let failNext = true
    vi.doMock('@kamiazya/whiteboard-loro-adapter', async (importOriginal) => {
      const adapter = await importOriginal<typeof import('@kamiazya/whiteboard-loro-adapter')>()
      return {
        ...adapter,
        loadCrdtEngine: () => {
          if (!failNext) return adapter.loadCrdtEngine()
          failNext = false
          return Promise.reject(new Error('engine failed to load'))
        },
      }
    })
    const { decodeSpatialSnapshot } = await import('./decode-spatial-snapshot.js')
    await expect(decodeSpatialSnapshot(empty)).rejects.toThrow('engine failed to load')
    await expect(decodeSpatialSnapshot(empty)).resolves.toBeDefined()
  })
})
