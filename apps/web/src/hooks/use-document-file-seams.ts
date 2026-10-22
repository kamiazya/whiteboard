/**
 * The editor's file-reference seam — referenced-canvas embeds (J5a), image
 * nodes (J5b), markdown bodies and facet cards — with the backend factored
 * out behind `DocumentFileAdapter`.
 *
 * This exists because the logic was written inline in one page, so the other
 * page shipped without any of it: canvas embeds and image nodes worked in
 * browser mode and silently did nothing in daemon mode. The caching
 * rules here (staleness stamps, the same-instance guard, URL revocation) are
 * subtle enough that a second hand-written copy is the wrong answer.
 *
 * `resolveReference` is SYNCHRONOUS by the editor's contract, so it is a
 * cache lookup over content this hook pre-fetches through
 * `usePrefetchedEntries`. A broken reference keeps the card and never takes
 * down a page; a read that failed is asked again a bounded number of times.
 */

import {
  type FacetCardData,
  imageTargets,
  type LoadedReference,
  type ReferenceExtra,
  type ReferenceWire,
  referenceTargets,
  referenceWire,
} from '@kamiazya/whiteboard-canvas-render'
import type { AliasResolver } from '@kamiazya/whiteboard-codec'
import {
  documentIdSchema,
  type SpatialCanvas,
  type StoredCoreFacets,
} from '@kamiazya/whiteboard-model'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { ClipboardImageSeams } from '../lib/clipboard-images.js'
import type {
  DocumentFileAdapter,
  ImageStoreResult,
  LoadedFileDocument,
} from '../lib/document-file-contract.js'
import { useImageUrls } from './use-image-urls.js'
import { TRANSIENT_LOAD_ATTEMPTS, usePrefetchedEntries } from './use-prefetched-cache.js'

export interface UseDocumentFileSeamsOptions {
  readonly canvas: SpatialCanvas
  readonly adapter: DocumentFileAdapter
  /** The page's list-based alias table and names, ahead of any load. */
  readonly resolveAlias?: AliasResolver
  readonly resolveTitle?: (documentId: string) => string | undefined
  /**
   * Reference -> an opaque revision marker (the referenced canvas's
   * `updatedAt`). A moved marker is what makes an edit made elsewhere show up
   * on the next refresh; an absent one simply never invalidates.
   */
  readonly stampOf: ReadonlyMap<string, string>
  /**
   * Bodies laid out BESIDE the canvas — a node's text as it is being drafted
   * in the editor overlay (`useNodeInEditor`'s `draftBodies`) — whose
   * references load like the canvas's own, so the overlay's preview resolves
   * a link before the commit puts it on the canvas. REQUIRED rather than
   * optional for the reason `useNodeInEditor` gives for its document key: a
   * page that forgot it would compile clean and silently lose the preview.
   * Referentially stable: it is a load-effect dependency.
   */
  readonly bodies: readonly string[]
}

export interface DocumentFileSeams {
  /**
   * Everything the canvas points at, as DATA: what this hook loaded, the
   * page's alias and title tables evaluated over it, and what a file
   * reference carries beyond its document (an image asset, a facet card).
   * The editor builds the reference bundle from it on both threads — the
   * layout worker cannot take a function — so the two renders cannot
   * disagree; a surface beside the canvas builds its own with
   * `referenceSeamsFromWire`. The shape is the editor's prop set, so a page
   * hands the object over and spreads it once.
   */
  references: ReferenceWire
  onAddImage: (file: File) => Promise<ImageStoreResult>
  isImageFileRef: (file: string) => boolean
  /** What a copy and paste need of this keeper to carry its pictures elsewhere. */
  clipboardImages: ClipboardImageSeams
}

/**
 * What this keeper loaded for one reference, minus the facets, which are a
 * surface extra. `null` keeps the terminal "nothing here" slot so the seams
 * answer without the layout retrying. The id the page's table resolved a
 * written path to rides on the record, so a body's `![[path]]` finds it by id.
 */
function loadedReferenceFor(
  ref: string,
  document: { name?: string; body?: string; canvas?: LoadedReference['canvas'] } | null,
  resolveAlias: AliasResolver | undefined,
): LoadedReference | null {
  if (document === null) return null
  const documentId = documentIdSchema.safeParse(ref).success
    ? ref
    : (resolveAlias?.(ref) ?? undefined)
  return {
    ...(documentId !== undefined ? { documentId } : {}),
    ...(document.name !== undefined ? { name: document.name } : {}),
    ...(document.body !== undefined ? { body: document.body } : {}),
    ...(document.canvas !== undefined ? { canvas: document.canvas } : {}),
  }
}

/**
 * `loadedReferenceFor`, answering the SAME record for the same loaded
 * document for as long as the alias table is the same. The walk remembers
 * what it read of a record by its identity, so a record rebuilt on every load
 * that lands is a body read again on every load that lands.
 */
function useLoadedReferences(
  resolveAlias: AliasResolver | undefined,
): (ref: string, document: LoadedFileDocument | null) => LoadedReference | null {
  return useMemo(() => {
    const records = new WeakMap<LoadedFileDocument, { ref: string; record: LoadedReference }>()
    return (ref, document) => {
      if (document === null) return null
      const known = records.get(document)
      if (known !== undefined && known.ref === ref) return known.record
      const record = loadedReferenceFor(ref, document, resolveAlias)
      if (record !== null) records.set(document, { ref, record })
      return record
    }
  }, [resolveAlias])
}

/**
 * A prefetch key is the reference AND the stamp it was asked under, so a moved
 * stamp is a key never fetched and the shared hook loads it like any other.
 * NUL cannot occur in a reference or a stamp, so splitting on it is exact.
 */
const STAMP_SEPARATOR = '\u0000'
const keyOf = (ref: string, stamp: string) => `${ref}${STAMP_SEPARATOR}${stamp}`
const refOf = (key: string) => key.slice(0, key.indexOf(STAMP_SEPARATOR))

/**
 * What has loaded, by reference: the answer under the CURRENT stamp where
 * there is one, else the latest answer under an earlier stamp — so an edit
 * made elsewhere keeps the embed drawn while its new revision loads, and a
 * slow load under an old stamp cannot land over a newer one.
 */
function byReference<V>(
  cache: ReadonlyMap<string, V>,
  stampOf: ReadonlyMap<string, string>,
): Map<string, V> {
  const out = new Map<string, V>()
  // Insertion order is completion order, so the last write is the latest answer.
  for (const [key, value] of cache) out.set(refOf(key), value)
  for (const [key, value] of cache) {
    const ref = refOf(key)
    if (key === keyOf(ref, stampOf.get(ref) ?? '')) out.set(ref, value)
  }
  return out
}

export function useDocumentFileSeams({
  canvas,
  adapter,
  resolveAlias,
  resolveTitle,
  stampOf,
  bodies,
}: UseDocumentFileSeamsOptions): DocumentFileSeams {
  // Kept in a ref so a caller that rebuilds its adapter object every render
  // cannot restart the fetch effects; the adapter is a backend binding, not
  // reactive state.
  const adapterRef = useRef(adapter)
  adapterRef.current = adapter
  const recordFor = useLoadedReferences(resolveAlias)

  // Everything the canvas points at — its file nodes AND what its text nodes
  // embed or link, transitively through what has loaded — plus what a body
  // drafted beside it names, minus image assets, which are not documents.
  // A rejection is the adapter's "could not read" (see `DocumentFileAdapter`),
  // so it is asked again; `undefined` is "nothing here", terminal until the
  // stamp moves.
  // Read by the eviction callback, which runs when a load lands — after a
  // commit — so the stamps it sees are the committed render's.
  const stampRef = useRef(stampOf)
  useLayoutEffect(() => {
    stampRef.current = stampOf
  }, [stampOf])
  const cache = usePrefetchedEntries<LoadedFileDocument>(
    useCallback(
      (loaded) => {
        const graph = new Map<string, LoadedReference | null>()
        for (const [ref, document] of byReference(loaded, stampOf)) {
          graph.set(ref, recordFor(ref, document))
        }
        return referenceTargets({ canvases: [canvas], bodies, loaded: graph }).map((ref) => ({
          key: keyOf(ref, stampOf.get(ref) ?? ''),
          load: () => adapterRef.current.loadDocument(ref),
          attempts: TRANSIENT_LOAD_ATTEMPTS,
        }))
      },
      [bodies, canvas, recordFor, stampOf],
    ),
    // One answer per reference: the current stamp's once it has landed, and
    // until then the latest earlier one, so the embed stays drawn while its
    // new revision loads. Every other revision is memory the page never reads.
    useCallback((landed: string, entries: ReadonlyMap<string, unknown>) => {
      const ref = refOf(landed)
      const current = keyOf(ref, stampRef.current.get(ref) ?? '')
      const keep = entries.has(current) ? current : landed
      return [...entries.keys()].filter((key) => key !== keep && refOf(key) === ref)
    }, []),
  )
  // `null` is the terminal "nothing here" slot, kept so the seams answer
  // without the layout retrying. A document with facets but no canvas is
  // still a hit — it is what renders the facet card.
  const embedContent = useMemo(() => byReference(cache, stampOf), [cache, stampOf])

  // The shared record per reference: what this keeper loaded, minus the
  // facets, which are a surface extra below.
  const graph = useMemo(() => {
    const entries = new Map<string, LoadedReference | null>()
    for (const [ref, document] of embedContent) {
      entries.set(ref, recordFor(ref, document))
    }
    return entries
  }, [embedContent, recordFor])

  // Every picture this render draws, from the one definition
  // (`storedImageRefs`): a canvas's image file nodes, frame backgrounds, and
  // what a body or a text node writes inline, the drafted bodies included.
  const imageUrls = useImageUrls(
    useMemo(
      () => imageTargets({ canvases: [canvas], bodies, loaded: graph }),
      [bodies, canvas, graph],
    ),
    useCallback((ref: string) => adapterRef.current.loadImageUrl(ref), []),
  )

  // What this surface adds beside the content, as data so it rides the
  // wire as-is. An image reference is never loaded as a document, so its
  // href stands alone, and the layout ranks an image above everything
  // anyway; a document with readable facets carries its card.
  const extras = useMemo(() => {
    const out = new Map<string, ReferenceExtra>()
    for (const [ref, href] of imageUrls) out.set(ref, { image: { href } })
    for (const [ref, document] of embedContent) {
      if (document === null || out.has(ref)) continue
      const facets = toFacetCard(ref, document.facets, document.name)
      if (facets !== undefined) out.set(ref, { facets })
    }
    return out
  }, [embedContent, imageUrls])

  const references = useMemo(
    () =>
      referenceWire(graph, {
        ...(resolveAlias !== undefined ? { resolveAlias } : {}),
        ...(resolveTitle !== undefined ? { resolveTitle } : {}),
        extras,
      }),
    [graph, extras, resolveAlias, resolveTitle],
  )
  const onAddImage = useCallback((file: File) => adapterRef.current.storeImage(file), [])
  const isImageFileRef = useCallback((file: string) => adapterRef.current.isImageRef(file), [])
  const clipboardImages = useClipboardImageSeams(adapter)
  return { references, onAddImage, isImageFileRef, clipboardImages }
}

/**
 * The keeper's picture seams for copy and paste, stable while its scope is.
 * Reads and stores through the CURRENT adapter, as the seams above do.
 */
function useClipboardImageSeams(adapter: DocumentFileAdapter): ClipboardImageSeams {
  const adapterRef = useRef(adapter)
  adapterRef.current = adapter
  const { fileScope } = adapter
  return useMemo(
    () => ({
      fileScope,
      readImage: readImageBytes(adapterRef),
      storeImage: (file: File) => adapterRef.current.storeImage(file),
    }),
    [fileScope],
  )
}

/**
 * A stored picture's bytes, from the keeper itself. Never a fetch of the
 * displayable URL: the shipped policy refuses `connect-src blob:`.
 */
function readImageBytes(adapterRef: { readonly current: DocumentFileAdapter }) {
  return (ref: string): Promise<Blob | undefined> => adapterRef.current.loadImageBlob(ref)
}

/**
 * The one place core facets become card content. canvas-render is told WHAT
 * to draw and never what a facet means, so every semantic choice — which
 * field is the heading, which become rows, what a tag list reads like — is
 * made here.
 *
 * `view` selects a template rather than carrying content, `resource` names
 * what the document describes rather than saying anything about it, and
 * `facetsRaw` holds keys with no agreed presentation, so none of the three
 * renders.
 */
export function toFacetCard(
  ref: string,
  facets: StoredCoreFacets | undefined,
  name?: string,
): FacetCardData | undefined {
  if (facets === undefined) return undefined
  const rows = [{ label: 'type', value: facets.type }]
  // OKF's own words for `description`: the one sentence summarising the
  // concept, "used by index.md generators, search snippets, and previews"
  // (§4.1). An embed card IS a preview, so it is the row a reader wants most
  // after knowing what kind of thing this is.
  if (facets.description !== undefined) {
    rows.push({ label: 'summary', value: facets.description })
  }
  if (facets.tags !== undefined && facets.tags.length > 0) {
    rows.push({ label: 'tags', value: facets.tags.join(', ') })
  }
  // The heading is the document's NAME, which the workspace owns (ADR-0009
  // decision 2) — never `type`, which made every card read "note" and
  // identified nothing.
  //
  // ponytail: `ref` — the id or path — when the adapter cannot supply a name,
  // because the daemon's canvas summary carries no display name yet (see
  // DaemonDocumentPage's note). Once it does, that fallback goes.
  return { title: name ?? ref, rows }
}
