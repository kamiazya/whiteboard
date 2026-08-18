/**
 * Content loading for inline canvas embeds (embed spec J5a-2), browser-local
 * flavor: a file node's reference is a browser-local canvas id, and the
 * editor's `resolveReference` seam is SYNCHRONOUS by contract — so the page
 * pre-fetches referenced documents here and hands the editor a cache lookup.
 *
 * Totality mirrors the layout seam: any load/import failure resolves to
 * `undefined` and the editor keeps the card — a broken reference must never
 * take down the page.
 */

import {
  readCoreFacets,
  readMarkdownBody,
  readSpatialCanvas,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { isImageRef, newImageRef } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import type { DocumentFileAdapter, LoadedFileDocument } from '../hooks/use-document-file-seams.js'
import { getAppLogger } from './app-logger.js'
import { IndexedDBStore } from './browser-local-store.js'
import { DocumentFileStore } from './document-file-store.js'
import { LoroStore } from './loro-store.js'

const log = getAppLogger('document-embed-content')

/**
 * A referenced document's NAME. It lives in the snapshot row rather than the
 * Loro document, because the workspace owns naming and the content holds no
 * copy of it (ADR-0009 decision 2) — so reading one costs a second store hit
 * that no amount of care over the content load can save.
 *
 * Total like every loader here: an unnamed, missing or corrupt row is
 * `undefined`, and the caller falls back to the reference.
 */
async function loadDocumentName(documentId: string): Promise<string | undefined> {
  try {
    const result = await new IndexedDBStore().load(documentId)
    if (result.kind !== 'ok') return undefined
    // `untitled` is the store's sentinel for an unnamed canvas, not a name.
    return result.snapshot.name === 'untitled' ? undefined : result.snapshot.name
  } catch (err) {
    log.warn('document name load failed', { documentId, err })
    return undefined
  }
}

/** Loads one referenced canvas's spatial content from IndexedDB. */
async function loadEmbeddedDocument(documentId: string): Promise<LoadedFileDocument | undefined> {
  try {
    const result = await new LoroStore().load(documentId)
    if (result.kind !== 'ok') return undefined
    const doc = new Loro()
    doc.import(result.snapshot)
    for (const delta of result.deltas ?? []) doc.import(delta)
    // One load, every read — the doc used to be discarded after the canvas
    // read, which is why neither facets nor the body need a second store
    // round-trip.
    const body = readMarkdownBody(doc)
    const name = await loadDocumentName(documentId)
    return {
      canvas: readSpatialCanvas(doc),
      facets: readCoreFacets(doc),
      ...(name !== undefined ? { name } : {}),
      ...(body.length > 0 ? { body } : {}),
    }
  } catch (err) {
    log.warn('embedded document load failed', { documentId, err })
    return undefined
  }
}

/**
 * Loads one referenced MARKDOWN document's body (and title facet) from the
 * same store — the loader behind `useMarkdownEmbedContent`'s cache, total
 * like its spatial sibling above.
 */
export async function loadMarkdownEmbedSource(
  documentId: string,
): Promise<{ body: string; title?: string } | undefined> {
  try {
    const result = await new LoroStore().load(documentId)
    if (result.kind !== 'ok') return undefined
    const doc = new Loro()
    doc.import(result.snapshot)
    for (const delta of result.deltas ?? []) doc.import(delta)
    const title = await loadDocumentName(documentId)
    return { body: readMarkdownBody(doc), ...(title !== undefined ? { title } : {}) }
  } catch (err) {
    log.warn('embedded markdown load failed', { documentId, err })
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
    await new DocumentFileStore().put(ref, {
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
  const blob = await new DocumentFileStore().get(ref)
  if (blob === null) return undefined
  return URL.createObjectURL(blob)
}

/**
 * The browser-local binding of the editor's file seams. Declared here beside
 * the four functions it wires so the page is left with no backend knowledge
 * of its own — the daemon page supplies its own adapter over the daemon's
 * `/api/w/:workspaceId/document/:path/file/:fileId` endpoints.
 */
export const BROWSER_LOCAL_FILE_ADAPTER: DocumentFileAdapter = {
  isImageRef,
  loadDocument: loadEmbeddedDocument,
  loadImageUrl: loadImageAssetUrl,
  storeImage: storeImageAsset,
}
