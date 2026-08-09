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
import type { SpatialCanvas } from '@kamiazya/whiteboard-canvas-model'
import { useCallback, useEffect, useRef, useState } from 'react'
import { collectFileRefs } from '../lib/canvas-embed-content.js'

/** What a backend must supply for the seams to work against it. */
export interface CanvasFileAdapter {
  /** Distinguishes a stored image asset from a reference to another canvas. */
  isImageRef(file: string): boolean
  /** Resolves a canvas reference to its spatial content, or undefined. */
  loadCanvas(ref: string): Promise<SpatialCanvas | undefined>
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
  resolveFileImage: (file: string) => { href: string } | undefined
  onAddImage: (file: File) => Promise<string | undefined>
  isImageFileRef: (file: string) => boolean
}

export function useCanvasFileSeams({
  canvas,
  adapter,
  stampOf,
}: UseCanvasFileSeamsOptions): CanvasFileSeams {
  const [embedContent, setEmbedContent] = useState<ReadonlyMap<string, SpatialCanvas>>(new Map())
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
    const stale = refs.filter(
      (ref) => !embedContent.has(ref) || embedStampsRef.current.get(ref) !== stampOf.get(ref),
    )
    if (stale.length === 0) return
    let cancelled = false
    void Promise.all(
      stale.map(async (ref) => [ref, await adapterRef.current.loadCanvas(ref)] as const),
    ).then((loaded) => {
      if (cancelled) return
      setEmbedContent((prev) => {
        const next = new Map(prev)
        for (const [ref, content] of loaded) {
          if (content !== undefined) next.set(ref, content)
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

  const resolveFileCanvas = useCallback((file: string) => embedContent.get(file), [embedContent])
  const resolveFileImage = useCallback(
    (file: string) => {
      const href = imageUrls.get(file)
      return href === undefined ? undefined : { href }
    },
    [imageUrls],
  )
  const onAddImage = useCallback((file: File) => adapterRef.current.storeImage(file), [])
  const isImageFileRef = useCallback((file: string) => adapterRef.current.isImageRef(file), [])

  return { resolveFileCanvas, resolveFileImage, onAddImage, isImageFileRef }
}
