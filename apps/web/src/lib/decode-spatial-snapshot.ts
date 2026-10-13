import type { SpatialCanvas } from '@kamiazya/whiteboard-model'

let loroBundle:
  | Promise<{
      readonly LoroDoc: typeof import('loro-crdt').LoroDoc
      readonly readSpatialCanvas: typeof import('@kamiazya/whiteboard-loro-adapter').readSpatialCanvas
    }>
  | undefined

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
  loroBundle ??= Promise.all([
    import('loro-crdt'),
    import('@kamiazya/whiteboard-loro-adapter'),
  ]).then(
    ([loro, adapter]) => ({
      LoroDoc: loro.LoroDoc,
      readSpatialCanvas: adapter.readSpatialCanvas,
    }),
    (error: unknown) => {
      // A chunk that failed to load once is asked for again by the next decode.
      loroBundle = undefined
      throw error
    },
  )
  const { LoroDoc, readSpatialCanvas } = await loroBundle
  const doc = new LoroDoc()
  doc.import(bytes)
  return readSpatialCanvas(doc)
}
