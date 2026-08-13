/**
 * The editor's four file seams — referenced-canvas embeds (J5a) and image
 * nodes (J5b) — with the backend factored out behind `CanvasFileAdapter`.
 *
 * This exists because the logic was written inline in one page, so the other
 * page shipped without any of it: canvas embeds and image nodes worked in
 * browser-local mode and silently did nothing in daemon mode. The caching
 * rules here (staleness stamps, the same-instance guard, URL revocation) are
 * subtle enough that a second hand-written copy is the wrong answer.
 *
 * `resolveFileCanvas`/`resolveFileImage` are SYNCHRONOUS by the editor's
 * contract, so both are cache lookups over content this hook pre-fetches.
 * Totality mirrors the layout seam: any load failure resolves to `undefined`
 * and the editor keeps the card — a broken reference never takes down a page.
 */
import type { CoreFacets, SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import type { FacetCardData } from '@kamiazya/whiteboard-canvas-render'
import { useCallback, useEffect, useRef, useState } from 'react'
import { collectFileRefs } from '../lib/canvas-embed-content.js'

/**
 * What one reference resolves to. Both halves are optional and independent:
 * a markdown document has facets and no spatial content, and a canvas
 * written before facets existed has content and none.
 */
export interface LoadedFileDocument {
  readonly canvas?: SpatialCanvas
  readonly facets?: CoreFacets
}

/** What a backend must supply for the seams to work against it. */
export interface CanvasFileAdapter {
  /** Distinguishes a stored image asset from a reference to another canvas. */
  isImageRef(file: string): boolean
  /**
   * Resolves a reference to the document behind it. Facets ride along on the
   * load the embed seam already performs — a second fetch just to read four
   * frontmatter fields would double every referenced document's cost.
   */
  loadDocument(ref: string): Promise<LoadedFileDocument | undefined>
  /** Resolves an image reference to a displayable URL, or undefined. */
  loadImageUrl(ref: string): Promise<string | undefined>
  /** Stores a picked/dropped/pasted image, returning its new reference. */
  storeImage(file: File): Promise<string | undefined>
}

export interface UseCanvasFileSeamsOptions {
  readonly canvas: SpatialCanvas
  readonly adapter: CanvasFileAdapter
  /**
   * Reference -> an opaque revision marker (the referenced canvas's
   * `updatedAt`). A moved marker is what makes an edit made elsewhere show up
   * on the next refresh; an absent one simply never invalidates.
   */
  readonly stampOf: ReadonlyMap<string, string>
}

export interface CanvasFileSeams {
  resolveFileCanvas: (file: string) => SpatialCanvas | undefined
  resolveFileFacets: (file: string) => FacetCardData | undefined
  resolveFileImage: (file: string) => { href: string } | undefined
  onAddImage: (file: File) => Promise<string | undefined>
  isImageFileRef: (file: string) => boolean
}

export function useCanvasFileSeams({
  canvas,
  adapter,
  stampOf,
}: UseCanvasFileSeamsOptions): CanvasFileSeams {
  const [embedContent, setEmbedContent] = useState<ReadonlyMap<string, LoadedFileDocument>>(
    new Map(),
  )
  const embedStampsRef = useRef<Map<string, string>>(new Map())
  // Image assets are immutable once stored, so object URLs cache for the
  // lifetime of the page and are revoked together on unmount.
  const [imageUrls, setImageUrls] = useState<ReadonlyMap<string, string>>(new Map())
  const imageUrlsRef = useRef<ReadonlyMap<string, string>>(imageUrls)
  imageUrlsRef.current = imageUrls

  // Kept in a ref so a caller that rebuilds its adapter object every render
  // cannot restart the fetch effects; the adapter is a backend binding, not
  // reactive state.
  const adapterRef = useRef(adapter)
  adapterRef.current = adapter

  useEffect(
    () => () => {
      for (const url of imageUrlsRef.current.values()) URL.revokeObjectURL(url)
    },
    [],
  )

  useEffect(() => {
    const refs = collectFileRefs(canvas).filter((ref) => !adapterRef.current.isImageRef(ref))
    if (refs.length === 0) return
    // Normalised on BOTH sides: the write below stores `?? ''`, so comparing
    // against a raw `undefined` left a reference with no stamp entry (a
    // dangling one, or a document absent from the page's list) permanently
    // stale, reloading it on every render.
    const stale = refs.filter(
      (ref) =>
        !embedContent.has(ref) || embedStampsRef.current.get(ref) !== (stampOf.get(ref) ?? ''),
    )
    if (stale.length === 0) return
    let cancelled = false
    void Promise.all(
      stale.map(async (ref) => [ref, await adapterRef.current.loadDocument(ref)] as const),
    ).then((loaded) => {
      if (cancelled) return
      setEmbedContent((prev) => {
        const next = new Map(prev)
        for (const [ref, document] of loaded) {
          // A document with facets but no canvas is still a cache HIT — it is
          // what renders the facet card.
          if (document !== undefined) next.set(ref, document)
          else next.delete(ref)
          embedStampsRef.current.set(ref, stampOf.get(ref) ?? '')
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [canvas, embedContent, stampOf])

  useEffect(() => {
    const refs = collectFileRefs(canvas).filter(
      (ref) => adapterRef.current.isImageRef(ref) && !imageUrls.has(ref),
    )
    if (refs.length === 0) return
    let cancelled = false
    void Promise.all(
      refs.map(async (ref) => [ref, await adapterRef.current.loadImageUrl(ref)] as const),
    ).then((loaded) => {
      if (cancelled) return
      setImageUrls((prev) => {
        // When every load failed, keep the SAME map instance: a fresh (equal)
        // map would re-trigger this effect and spin the failed reads forever.
        // Failed refs retry only on the next canvas change.
        let added = false
        const next = new Map(prev)
        for (const [ref, url] of loaded) {
          if (url !== undefined) {
            next.set(ref, url)
            added = true
          }
        }
        return added ? next : prev
      })
    })
    return () => {
      cancelled = true
    }
  }, [canvas, imageUrls])

  const resolveFileCanvas = useCallback(
    (file: string) => {
      // A markdown document reads back as a canvas with no nodes. Embedding
      // one draws an empty frame that outranks the facet card and shows
      // strictly less, so "nothing to embed" is the honest answer.
      const canvas = embedContent.get(file)?.canvas
      return canvas === undefined || canvas.nodes.length === 0 ? undefined : canvas
    },
    [embedContent],
  )
  const resolveFileFacets = useCallback(
    (file: string) => toFacetCard(embedContent.get(file)?.facets),
    [embedContent],
  )
  const resolveFileImage = useCallback(
    (file: string) => {
      const href = imageUrls.get(file)
      return href === undefined ? undefined : { href }
    },
    [imageUrls],
  )
  const onAddImage = useCallback((file: File) => adapterRef.current.storeImage(file), [])
  const isImageFileRef = useCallback((file: string) => adapterRef.current.isImageRef(file), [])

  return { resolveFileCanvas, resolveFileFacets, resolveFileImage, onAddImage, isImageFileRef }
}

/**
 * The one place core facets become card content. canvas-render is told WHAT
 * to draw and never what a facet means, so every semantic choice — which
 * field is the heading, which become rows, what a tag list reads like — is
 * made here.
 *
 * `view` selects a template rather than carrying content, and `facetsRaw`
 * holds keys with no agreed presentation, so neither renders.
 */
export function toFacetCard(facets: CoreFacets | undefined): FacetCardData | undefined {
  if (facets === undefined) return undefined
  const rows = [{ label: 'type', value: facets.type }]
  if (facets.tags !== undefined && facets.tags.length > 0) {
    rows.push({ label: 'tags', value: facets.tags.join(', ') })
  }
  // `type` is required by the schema, so a parsed facet set always yields a
  // heading and at least one row — an empty card is unrepresentable here.
  return { title: facets.title ?? facets.type, rows }
}
