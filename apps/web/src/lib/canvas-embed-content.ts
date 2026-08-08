/**
 * Content loading for inline canvas embeds (embed spec J5a-2), browser-local
 * flavor: a file node's reference is a browser-local canvas id, and the
 * editor's `resolveFileCanvas` seam is SYNCHRONOUS by contract — so the page
 * pre-fetches referenced canvases here and hands the editor a cache lookup.
 *
 * Totality mirrors the layout seam: any load/import failure resolves to
 * `undefined` and the editor keeps the card — a broken reference must never
 * take down the page.
 */
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { readSpatialCanvas } from '@kamiazya/whiteboard-canvas-workspace'
import { Loro } from 'loro-crdt'
import { getAppLogger } from './app-logger.js'
import { LoroStore } from './loro-store.js'

const log = getAppLogger('canvas-embed-content')

/** Loads one referenced canvas's spatial content from IndexedDB. */
export async function loadEmbeddedSpatialCanvas(
  canvasId: string,
): Promise<SpatialCanvas | undefined> {
  try {
    const result = await new LoroStore().load(canvasId)
    if (result.kind !== 'ok') return undefined
    const doc = new Loro()
    doc.import(result.snapshot)
    for (const delta of result.deltas ?? []) doc.import(delta)
    return readSpatialCanvas(doc)
  } catch (err) {
    log.warn('embedded canvas load failed', { canvasId, err })
    return undefined
  }
}

/** The file references present in a canvas, deduplicated. */
export function collectFileRefs(canvas: SpatialCanvas): readonly string[] {
  return [...new Set(canvas.nodes.flatMap((node) => (node.type === 'file' ? [node.file] : [])))]
}
