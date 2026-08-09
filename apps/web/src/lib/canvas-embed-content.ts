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
import type { CanvasFileAdapter } from '../hooks/use-canvas-file-seams.js'
import { getAppLogger } from './app-logger.js'
import { isImageRef, newImageRef } from './canvas-file-ref.js'
import { CanvasFileStore } from './canvas-file-store.js'
import { LoroStore } from './loro-store.js'

const log = getAppLogger('canvas-embed-content')

/** Loads one referenced canvas's spatial content from IndexedDB. */
async function loadEmbeddedSpatialCanvas(canvasId: string): Promise<SpatialCanvas | undefined> {
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

/**
 * Stores a picked/dropped/pasted image in the canvas file store and returns
 * the reference for the created file node, or undefined on failure.
 */
async function storeImageAsset(file: File): Promise<string | undefined> {
  try {
    const ref = newImageRef(crypto.randomUUID())
    await new CanvasFileStore().put(ref, {
      mimeType: file.type,
      blob: file,
      created: Date.now(),
    })
    return ref
  } catch (err) {
    log.warn('image asset store failed', { err })
    return undefined
  }
}

/** Loads a stored image asset as an object URL, or undefined when missing. */
async function loadImageAssetUrl(ref: string): Promise<string | undefined> {
  const blob = await new CanvasFileStore().get(ref)
  if (blob === null) return undefined
  return URL.createObjectURL(blob)
}

/**
 * The browser-local binding of the editor's file seams. Declared here beside
 * the four functions it wires so the page is left with no backend knowledge
 * of its own — the daemon page supplies its own adapter over the daemon's
 * `/api/canvas/:workspaceId/:slug/file/:fileId` endpoints.
 */
export const BROWSER_LOCAL_FILE_ADAPTER: CanvasFileAdapter = {
  isImageRef,
  loadCanvas: loadEmbeddedSpatialCanvas,
  loadImageUrl: loadImageAssetUrl,
  storeImage: storeImageAsset,
}
