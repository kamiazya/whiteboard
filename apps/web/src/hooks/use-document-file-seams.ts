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
 * cache lookup over content this hook pre-fetches. Totality mirrors the
 * layout seam: any load failure resolves to `undefined` and the editor keeps
 * the card — a broken reference never takes down a page.
 */

import {
  type FacetCardData,
  type LoadedReference,
  type ReferenceSeams,
  referenceSeams,
} from '@kamiazya/whiteboard-canvas-render'
import type { AliasResolver } from '@kamiazya/whiteboard-codec'
import type { SpatialCanvas, StoredCoreFacets } from '@kamiazya/whiteboard-model'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { collectFileRefs } from '../lib/document-embed-content.js'
import type { DocumentFileAdapter, LoadedFileDocument } from '../lib/document-file-contract.js'

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
}

export interface DocumentFileSeams {
  /**
   * Every reference seam over what this hook has loaded, built by
   * canvas-render's `referenceSeams` — the layout ranks the fields, this
   * hook only reaches the keeper and adds what a file reference carries
   * beyond its document (an image asset, a facet card).
   */
  references: ReferenceSeams
  onAddImage: (file: File) => Promise<string | undefined>
  isImageFileRef: (file: string) => boolean
}

export function useDocumentFileSeams({
  canvas,
  adapter,
  resolveAlias,
  resolveTitle,
  stampOf,
}: UseDocumentFileSeamsOptions): DocumentFileSeams {
  // `null` = the adapter answered "there is nothing here". It has to OCCUPY
  // the slot rather than leave it absent: absent means "not fetched yet", so
  // dropping the result made the next staleness pass ask again — while the
  // drop itself published a new map instance and scheduled that pass. The
  // image loop below already guards this exact shape by returning the SAME
  // instance when nothing was added.
  const [embedContent, setEmbedContent] = useState<ReadonlyMap<string, LoadedFileDocument | null>>(
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
          // what renders the facet card. So is one that resolved to nothing;
          // the stamp is what brings it back if the target later appears.
          next.set(ref, document ?? null)
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

  // The shared record per reference: what this keeper loaded, minus the
  // facets, which are a surface extra below. `null` keeps the terminal
  // "nothing here" slot so the seams answer without the layout retrying.
  const graph = useMemo(() => {
    const entries = new Map<string, LoadedReference | null>()
    for (const [ref, document] of embedContent) {
      entries.set(
        ref,
        document === null
          ? null
          : {
              ...(document.name !== undefined ? { name: document.name } : {}),
              ...(document.body !== undefined ? { body: document.body } : {}),
              ...(document.canvas !== undefined ? { canvas: document.canvas } : {}),
            },
      )
    }
    return entries
  }, [embedContent])

  const references = useMemo(
    () =>
      referenceSeams(graph, {
        ...(resolveAlias !== undefined ? { resolveAlias } : {}),
        ...(resolveTitle !== undefined ? { resolveTitle } : {}),
        extra: (ref) => {
          // Checked first and returned alone: an image reference is never
          // loaded as a document, so there is nothing else to carry, and the
          // layout ranks an image above everything anyway.
          const href = imageUrls.get(ref)
          if (href !== undefined) return { image: { href } }
          const document = embedContent.get(ref)
          if (document === undefined || document === null) return undefined
          const facets = toFacetCard(ref, document.facets, document.name)
          return facets === undefined ? undefined : { facets }
        },
      }),
    [graph, embedContent, imageUrls, resolveAlias, resolveTitle],
  )
  const onAddImage = useCallback((file: File) => adapterRef.current.storeImage(file), [])
  const isImageFileRef = useCallback((file: string) => adapterRef.current.isImageRef(file), [])

  return { references, onAddImage, isImageFileRef }
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
