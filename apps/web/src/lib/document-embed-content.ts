/**
 * Content loading for inline canvas embeds (embed spec J5a-2), browser
 * flavor: a file node's reference is a canvas id minted in the browser, and the
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
import type { DocumentKind, SpatialCanvas } from '@kamiazya/whiteboard-model'
import { isImageRef, newImageRef } from '@kamiazya/whiteboard-model'
import { getAppLogger } from './app-logger.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import type { DocumentFileAdapter, LoadedFileDocument } from './document-file-contract.js'
import { DocumentFileStore } from './document-file-store.js'
import { FoldingBrowserIndex } from './folding-browser-index.js'
import { loadDocumentContent } from './workspace-content.js'

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
// Lazy singleton, not per-call: the folding index memoizes its startup fold
// per instance, and a canvas full of embeds resolves one name per embed.
let embedIndex: FoldingBrowserIndex | null = null

/** The fold memo is per-instance, so a test that swaps the database out
 *  from under the singleton must also drop the folded instance. */
export function resetEmbedIndexForTests(): void {
  embedIndex = null
}

async function loadDocumentEntry(
  documentId: string,
): Promise<{ name?: string; kind?: DocumentKind } | undefined> {
  try {
    // The workspace tree owns naming; the production index's fold gate is
    // what makes a legacy record (row + content, not yet in the tree)
    // answer too — one read path, no second store of its own.
    embedIndex ??= new FoldingBrowserIndex()
    const entry = await embedIndex.resolveDocumentById({
      workspaceId: getBrowserWorkspaceId(),
      documentId,
    })
    if (entry === null) return undefined
    // A document with no name of its own reports one as ABSENT rather than as
    // the sentinel string the old metadata row used, so the caller's fallback
    // to the reference happens without anyone comparing against 'untitled'.
    return {
      ...(entry.name !== undefined ? { name: entry.name } : {}),
      ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
    }
  } catch (err) {
    log.warn('document entry load failed', { documentId, err })
    return undefined
  }
}

async function loadDocumentName(documentId: string): Promise<string | undefined> {
  return (await loadDocumentEntry(documentId))?.name
}

/** Loads one referenced canvas's spatial content from IndexedDB. */
async function loadEmbeddedDocument(documentId: string): Promise<LoadedFileDocument | undefined> {
  try {
    const doc = await loadDocumentContent(documentId)
    if (doc === null) return undefined
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
 * What an `![[embed]]` target loads as: a markdown document's raw body
 * (parsed once by the hook that caches it), or a spatial document's canvas
 * (drawn by the layout as a miniature). Declared here, in lib, because the
 * loaders that produce it live here and the hook above only consumes it.
 */
export type MarkdownEmbedSource =
  | { readonly body: string; readonly title?: string }
  | { readonly canvas: SpatialCanvas; readonly title?: string }

/**
 * Loads one `![[embed]]` target from the same store — the loader behind
 * `useMarkdownEmbedContent`'s cache, total like its spatial sibling above.
 * The workspace entry's kind decides what the target IS: a spatial document
 * answers its canvas, anything else its body. Kind comes from the index
 * rather than the content because the browser store writes it there, and a
 * spatial document's body is an empty string that says nothing.
 */
export async function loadMarkdownEmbedSource(
  documentId: string,
): Promise<MarkdownEmbedSource | undefined> {
  try {
    const doc = await loadDocumentContent(documentId)
    if (doc === null) return undefined
    const entry = await loadDocumentEntry(documentId)
    const title = entry?.name !== undefined ? { title: entry.name } : {}
    if (entry?.kind === 'spatial') return { ...title, canvas: readSpatialCanvas(doc) }
    return { ...title, body: readMarkdownBody(doc) }
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
 * The browser binding of the editor's file seams. Declared here beside
 * the four functions it wires so the page is left with no backend knowledge
 * of its own — the daemon page supplies its own adapter over the daemon's
 * `/api/w/:workspaceId/document/:path/file/:fileId` endpoints.
 */
export const BROWSER_FILE_ADAPTER: DocumentFileAdapter = {
  isImageRef,
  loadDocument: loadEmbeddedDocument,
  loadImageUrl: loadImageAssetUrl,
  storeImage: storeImageAsset,
}
