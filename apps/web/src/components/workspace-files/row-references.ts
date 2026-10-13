/**
 * What a row's picture needs of the documents its subject embeds or links:
 * the reference wire a render draws them from, and the key axis that names
 * what they were (`referencesKey`).
 *
 * Asked only for a document that names another — the worker says so of a
 * picture it drew without (`referencesOmitted`) — so a folder of documents
 * that embed nothing reads nothing here.
 *
 * Reads go through the keeper's own source, one per referenced document and
 * version for the loader's life: a folder of boards that all embed one note
 * reads it once. A referenced board's snapshot is decoded on THIS thread,
 * since the wire carries a canvas and the worker cannot read the keeper; that
 * is paid only by rows that embed a board, once per board and version.
 */

import {
  type LoadedReference,
  type ReferenceGraph,
  type ReferenceWire,
  referenceTargets,
  referenceWire,
} from '@kamiazya/whiteboard-canvas-render'
import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import { isImageRef, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import { linkEntries, linkTitles } from '../../lib/link-entries.js'
import { type ReferenceKeyRow, referencesKey } from '../../lib/render-key.js'

export interface RowReferences {
  readonly wire: ReferenceWire
  /** The `references` axis of the picture drawn from `wire`. */
  readonly key: string | null
}

let loroBundle:
  | Promise<{
      readonly LoroDoc: typeof import('loro-crdt').LoroDoc
      readonly readSpatialCanvas: typeof import('@kamiazya/whiteboard-loro-adapter').readSpatialCanvas
    }>
  | undefined

/**
 * Lazy, like the worker's: the panel's chunk need not carry loro's WASM for a
 * folder in which nothing embeds a board.
 */
async function decodeSnapshot(bytes: Uint8Array): Promise<SpatialCanvas> {
  loroBundle ??= Promise.all([
    import('loro-crdt'),
    import('@kamiazya/whiteboard-loro-adapter'),
  ]).then(([loro, adapter]) => ({
    LoroDoc: loro.LoroDoc,
    readSpatialCanvas: adapter.readSpatialCanvas,
  }))
  const { LoroDoc, readSpatialCanvas } = await loroBundle
  const doc = new LoroDoc()
  doc.import(bytes)
  return readSpatialCanvas(doc)
}

async function readContent(
  source: WorkspaceFilesSource,
  entry: WorkspaceDocumentEntry,
): Promise<LoadedReference> {
  const named = {
    documentId: entry.documentId,
    ...(entry.name === undefined ? {} : { name: entry.name }),
  }
  if (entry.kind === 'markdown') return { ...named, body: (await source.loadMarkdown(entry)).body }
  return { ...named, canvas: await decodeSnapshot(await source.loadSpatialSnapshot(entry)) }
}

/**
 * One read per document and content version, shared by every row the loader
 * draws. A document whose keeper reports no version is read every time: an
 * entry with nothing to tell its versions apart would answer for both.
 */
function contentReader(source: WorkspaceFilesSource) {
  const held = new Map<string, Promise<LoadedReference>>()
  return (entry: WorkspaceDocumentEntry): Promise<LoadedReference> => {
    if (entry.contentDigest === undefined) return readContent(source, entry)
    const key = `${entry.documentId}\n${entry.contentDigest}`
    let read = held.get(key)
    if (read === undefined) {
      read = readContent(source, entry)
      // A failed read is not remembered: the next row asks again.
      read.catch(() => held.delete(key))
      held.set(key, read)
    }
    return read
  }
}

/**
 * The reader a loader keeps: given a row, the wire its picture draws from.
 * Rejects when any read does — a picture missing an embed it could have
 * drawn must not be keyed as though that embed were dangling.
 */
export type RowReferenceReader = (document: WorkspaceDocumentEntry) => Promise<RowReferences>

export function createRowReferenceReader(
  source: WorkspaceFilesSource,
  documents: () => readonly WorkspaceDocumentEntry[],
): RowReferenceReader {
  const contentOf = contentReader(source)
  return async (document: WorkspaceDocumentEntry): Promise<RowReferences> => {
    const listed = documents()
    const resolveAlias = createUniqueNameResolver(linkEntries(listed))
    const resolveTitle = linkTitles(listed)
    const byId = new Map(listed.map((entry) => [entry.documentId, entry]))
    const resolve = (target: string) => byId.get(resolveAlias(target) ?? target)

    const root = await contentOf(document)
    const seeds =
      root.body !== undefined
        ? { bodies: [root.body] }
        : { canvases: root.canvas === undefined ? [] : [root.canvas] }
    // Walked as every keeper walks it: `referenceTargets` re-reads the graph
    // as it grows, under its own depth cap and budget. A picture is not a
    // document, and a row has no URL to draw one from.
    const graph = new Map<string, LoadedReference | null>()
    for (;;) {
      const wanted = referenceTargets({ ...seeds, loaded: graph }).filter(
        (target) => !graph.has(target) && !isImageRef(target),
      )
      if (wanted.length === 0) break
      const loaded = await Promise.all(
        wanted.map(async (target) => {
          const entry = resolve(target)
          return [target, entry === undefined ? null : await contentOf(entry)] as const
        }),
      )
      for (const [target, content] of loaded) graph.set(target, content)
    }

    return {
      wire: referenceWire(graph, { resolveAlias, resolveTitle }),
      key: await referencesKey(keyRows(graph, resolve, resolveTitle)),
    }
  }
}

function keyRows(
  graph: ReferenceGraph,
  resolve: (target: string) => WorkspaceDocumentEntry | undefined,
  resolveTitle: (documentId: string) => string | undefined,
): ReferenceKeyRow[] {
  return [...graph.keys()].map((target) => {
    const entry = resolve(target)
    if (entry === undefined) return { target }
    const label = resolveTitle(entry.documentId)
    return {
      target,
      documentId: entry.documentId,
      ...(entry.contentDigest === undefined ? {} : { version: entry.contentDigest }),
      ...(label === undefined ? {} : { label }),
    }
  })
}
