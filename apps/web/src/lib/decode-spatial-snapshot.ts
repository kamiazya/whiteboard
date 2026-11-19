import type { CrdtEngine } from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { bytesToBase64 } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

let engineBundle:
  | Promise<{
      readonly engine: CrdtEngine
      readonly randomPeerId: () => string
      readonly readValue: typeof import('@kamiazya/whiteboard-loro-adapter').readValue
    }>
  | undefined

// The answer is any-value by contract; the reader is the adapter's own
// readSpatialCanvas, which already yields the model's shape.
const canvasAnswer = z.object({ canvas: z.custom<SpatialCanvas>() })

/**
 * Decodes a stored snapshot into a canvas, in whichever realm asks — the
 * layout worker for a thumbnail, the main thread for a board another row
 * embeds.
 *
 * The import is lazy and memoized for the same reason `sse-shared-worker.ts`
 * defers its own: loro-crdt initialises WASM, and paying that at startup
 * would charge every markdown render and every editor layout — and every
 * chunk that imports this — for something only a spatial snapshot needs. The
 * first decode pays it once per realm.
 */
export async function decodeSpatialSnapshot(bytes: Uint8Array): Promise<SpatialCanvas> {
  engineBundle ??= import('@kamiazya/whiteboard-loro-adapter')
    .then(async (adapter) => ({
      engine: await adapter.loadCrdtEngine(),
      randomPeerId: adapter.randomPeerId,
      readValue: adapter.readValue,
    }))
    .catch((error: unknown) => {
      // A chunk or engine that failed to load once is asked for again by the next decode.
      engineBundle = undefined
      throw error
    })
  const { engine, randomPeerId, readValue } = await engineBundle
  const { handle } = engine.open({ peer: randomPeerId(), bytes: bytesToBase64(bytes) })
  try {
    return (await readValue(engine, handle, { query: 'spatialCanvas' }, canvasAnswer)).canvas
  } finally {
    engine.close({ handle })
  }
}
