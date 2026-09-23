/**
 * The reference seams for a markdown document being edited, the browser's
 * half of what canvas-render's `referenceSeams` builds: this hook prefetches
 * every document the body points at (direct and transitive, through the
 * markdown it finds — `referenceTargets` says what, so a new reference kind
 * lands here without this file changing) and hands the layout the bundle
 * over what it loaded.
 *
 * The layout's seams are SYNCHRONOUS by contract, so the fetch runs ahead
 * through `usePrefetchedEntries`; totality mirrors the seams — a load
 * failure caches as "nothing here", the preview keeps its placeholder, and
 * the failed target is never re-fetched in a retry storm.
 */
import {
  imageTargets,
  type LoadedReference,
  type ReferenceSeams,
  referenceSeams,
  referenceTargets,
} from '@kamiazya/whiteboard-canvas-render'
import type { AliasResolver } from '@kamiazya/whiteboard-codec'
import { documentIdSchema } from '@kamiazya/whiteboard-model'
import { useCallback, useMemo } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
import { loadBrowserReference } from '../lib/document-embed-content.js'
import { type LoadImageUrl, useImageUrls } from './use-image-urls.js'
import {
  type PrefetchRequest,
  TRANSIENT_LOAD_ATTEMPTS,
  usePrefetchedEntries,
} from './use-prefetched-cache.js'

const log = getAppLogger('reference-seams')

/**
 * Reaches a keeper for one reference. `documentId` is what the page's own
 * alias table resolved the written target to — a path to an id — or `null`
 * when the target is neither an id nor a known path, which a loader may
 * still answer (the daemon resolves a legacy path itself).
 */
export type ReferenceLoader = (
  target: string,
  documentId: string | null,
) => Promise<LoadedReference | undefined>

const loadFromBrowser: ReferenceLoader = (_target, documentId) =>
  documentId === null ? Promise.resolve(undefined) : loadBrowserReference(documentId)

export interface UseReferenceSeamsOptions {
  /** The body whose references seed the graph. */
  readonly body: string
  /** The page's list-based alias table, consulted before any load. */
  readonly resolveAlias?: AliasResolver
  /** The page's list-based names, consulted before any load. */
  readonly resolveTitle?: (documentId: string) => string | undefined
  /** Injection seam for tests and for the daemon page; defaults to the browser's Loro loader. */
  readonly load?: ReferenceLoader
  /**
   * Where a stored picture is, for the body's inline `![](asset:…)`. Absent,
   * the layout keeps the written URL — which is right for an absolute one and
   * is why a host that has no attachment store passes nothing rather than a
   * loader that always fails.
   */
  readonly loadImage?: LoadImageUrl
}

/**
 * What this body points at, as prefetch requests. `attempts` is the whole
 * reason these are declared rather than inlined: a reference's load reaches
 * a store, and a store read can fail transiently — the one answer the cache
 * above must not make terminal.
 */
function referenceRequests(
  body: string,
  loaded: ReadonlyMap<string, LoadedReference>,
  loadEntry: (target: string) => Promise<LoadedReference | undefined>,
): readonly PrefetchRequest<LoadedReference>[] {
  return referenceTargets({ bodies: [body], loaded }).map((target) => ({
    key: target,
    load: () => loadEntry(target),
    attempts: TRANSIENT_LOAD_ATTEMPTS,
  }))
}

export function useReferenceSeams({
  body,
  resolveAlias,
  resolveTitle,
  load = loadFromBrowser,
  loadImage,
}: UseReferenceSeamsOptions): ReferenceSeams {
  // A canonical id names itself, the way codec's reader treats it; anything
  // else is an alias the page's table may know. Resolved here, once per
  // target, so a loader is handed an id and never re-derives one.
  const documentIdOf = useCallback(
    (target: string): string | null =>
      documentIdSchema.safeParse(target).success ? target : (resolveAlias?.(target) ?? null),
    [resolveAlias],
  )

  const loadEntry = useCallback(
    async (target: string): Promise<LoadedReference | undefined> => {
      const documentId = documentIdOf(target)
      try {
        const loaded = await load(target, documentId)
        if (loaded === undefined) return undefined
        // The resolved id rides on the record so the seams can answer an
        // embed by id even when the body wrote a path.
        return documentId === null || loaded.documentId !== undefined
          ? loaded
          : { ...loaded, documentId }
      } catch (err) {
        // Re-thrown for the reason `loadBrowserReference` re-throws: the
        // prefetch treats a resolved `undefined` as the document's own
        // answer and never asks again, while a rejection is asked again.
        log.warn('reference load failed', { target, err })
        throw err
      }
    },
    [documentIdOf, load],
  )

  const cache = usePrefetchedEntries<LoadedReference>(
    useCallback((loaded) => referenceRequests(body, loaded, loadEntry), [body, loadEntry]),
  )

  // The pictures this body draws, from the same definition the board uses —
  // so an attachment written inline resolves here exactly as it does there,
  // rather than the preview inventing a second answer.
  const imageUrls = useImageUrls(
    useMemo(() => imageTargets({ bodies: [body], loaded: cache }), [body, cache]),
    loadImage,
  )

  return useMemo(
    () =>
      referenceSeams(cache, {
        ...(resolveAlias !== undefined ? { resolveAlias } : {}),
        ...(resolveTitle !== undefined ? { resolveTitle } : {}),
        extra: (ref) => {
          const href = imageUrls.get(ref)
          return href === undefined ? undefined : { image: { href } }
        },
      }),
    [cache, imageUrls, resolveAlias, resolveTitle],
  )
}
