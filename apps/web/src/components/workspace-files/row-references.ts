/**
 * What a row's picture needs of the documents its subject embeds or links:
 * the reference wire a render draws them from, and the key axis that names
 * what they were (`referencesKey`).
 *
 * Asked only for a document that names another or holds a stored picture
 * — the worker says so of a picture it drew without (`referencesOmitted`) —
 * so a folder of documents that embed nothing reads nothing here.
 *
 * Reads go through the keeper's own source, one per referenced document and
 * version for the loader's life: a folder of boards that all embed one note
 * reads it once. A board's snapshot — the row's own, and any board it
 * embeds — is decoded on THIS thread (`decode-spatial-snapshot.ts`), since
 * the wire carries a canvas and the worker cannot read the keeper; that is
 * paid only by rows whose picture names another document, once per board
 * and version.
 *
 * A stored picture rides the wire as a `data:` URL of its own bytes, since
 * the picture is remembered past the tab (ADR-0027) and a `blob:` URL would
 * name nothing there. The bytes are in every stored copy of the row's
 * picture, so they are capped: `ROW_IMAGE_MAX_BYTES` per picture and
 * `ROW_IMAGES_MAX_BYTES` per row, and a picture past either draws as its
 * card, deliberately. Measured against what a row costs without them: a
 * board's picture is 2.6–97 KB (ADR-0027's table), the broker's memo holds
 * up to 200 entries, and base64 adds a third — so the row cap bounds what
 * pictures can add to that memo at 200 × 683 KiB ≈ 133 MiB, were every
 * entry at the cap. The screenshots under `docs/assets` (14–53 KB, median
 * 36 KB) fit a row several times over; a phone photo (several MB) stays a
 * card. A picture past the cap is read once per loader to learn its size,
 * and dropped.
 */

import {
  imageTargets,
  type LoadedReference,
  type ReferenceExtra,
  type ReferenceGraph,
  type ReferenceWire,
  referenceWire,
  walkReferences,
} from '@kamiazya/whiteboard-canvas-render'
import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import { decodeSpatialSnapshot } from '../../lib/decode-spatial-snapshot.js'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { WorkspaceFilesSource } from '../../lib/files-source.js'
import { imageDataUrl } from '../../lib/image-data-url.js'
import { linkEntries, linkTitles } from '../../lib/link-entries.js'
import { type ReferenceKeyRow, referencesKey } from '../../lib/render-key.js'

export interface RowReferences {
  readonly wire: ReferenceWire
  /** The `references` axis of the picture drawn from `wire`. */
  readonly key: string | null
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
  return { ...named, canvas: await decodeSpatialSnapshot(await source.loadSpatialSnapshot(entry)) }
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

/** Stored bytes one picture may add to a row's picture (base64 adds a third). */
const ROW_IMAGE_MAX_BYTES = 256 * 1024

/** Stored bytes every picture in one row's picture may add together. */
const ROW_IMAGES_MAX_BYTES = 512 * 1024

interface InlinedImage {
  readonly href: string
  readonly bytes: number
}

/**
 * A picture's read, shared by every row asking while it is in flight. Once
 * it settles only a CARD is remembered for the loader's life — a few bytes
 * that spare re-reading a photo past the cap on every scroll. A `data:` URL
 * is not: the loader outlives any number of rows, and the picture the URL
 * went into is already held, bounded, by the broker. A blob is never held,
 * so a card does not keep megabytes alive to draw nothing.
 */
function imageReader(source: WorkspaceFilesSource) {
  const held = new Map<string, Promise<InlinedImage | undefined>>()
  const read = async (document: WorkspaceDocumentEntry, ref: string) => {
    const blob = await source.loadImage?.(document, ref)
    if (blob === undefined) return undefined
    const href = await imageDataUrl(blob, ROW_IMAGE_MAX_BYTES)
    return href === undefined ? undefined : { href, bytes: blob.size }
  }
  return (document: WorkspaceDocumentEntry, ref: string): Promise<InlinedImage | undefined> => {
    let inlined = held.get(ref)
    if (inlined === undefined) {
      inlined = read(document, ref)
      // A failed read is not remembered either: the next row asks again.
      inlined.then(
        (image) => image !== undefined && held.delete(ref),
        () => held.delete(ref),
      )
      held.set(ref, inlined)
    }
    return inlined
  }
}

/**
 * The pictures a row draws inline, in the order its content names them:
 * each one that still fits the row's remaining budget is drawn, and one that
 * does not stays a card without stopping a smaller one after it. Each is a key row
 * carrying the href it was drawn with, or '' for a card, so new bytes — or
 * a picture that arrives where a card was — are a different picture.
 */
async function inlineRowImages(
  refs: readonly string[],
  read: (ref: string) => Promise<InlinedImage | undefined>,
): Promise<{ readonly extras: Map<string, ReferenceExtra>; readonly rows: ReferenceKeyRow[] }> {
  const inlined = await Promise.all(refs.map(read))
  const extras = new Map<string, ReferenceExtra>()
  const rows: ReferenceKeyRow[] = []
  let budget = ROW_IMAGES_MAX_BYTES
  refs.forEach((ref, index) => {
    const image = inlined[index]
    const drawn = image !== undefined && image.bytes <= budget ? image : undefined
    if (drawn !== undefined) {
      budget -= drawn.bytes
      extras.set(ref, { image: { href: drawn.href } })
    }
    rows.push({ target: ref, image: drawn?.href ?? '' })
  })
  return { extras, rows }
}

/**
 * The reader a loader keeps: given a row, the wire its picture draws from.
 * Rejects when any read does — a picture missing an embed it could have
 * drawn must not be keyed as though that embed were dangling, nor one
 * missing an image as though the image were gone.
 */
export type RowReferenceReader = (document: WorkspaceDocumentEntry) => Promise<RowReferences>

export function createRowReferenceReader(
  source: WorkspaceFilesSource,
  documents: () => readonly WorkspaceDocumentEntry[],
): RowReferenceReader {
  const contentOf = contentReader(source)
  const imageOf = imageReader(source)
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
    // No `onFailure`: a failed read rejects the walk, so the row keeps its
    // bare picture instead of one keyed as though the embed were dangling.
    const graph = await walkReferences(seeds, async (target) => {
      const entry = resolve(target)
      return entry === undefined ? null : await contentOf(entry)
    })

    const images = await inlineRowImages(imageTargets({ ...seeds, loaded: graph }), (ref) =>
      imageOf(document, ref),
    )

    return {
      wire: referenceWire(graph, { resolveAlias, resolveTitle, extras: images.extras }),
      key: await referencesKey([...keyRows(graph, resolve, resolveTitle), ...images.rows]),
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
