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
import { type PrefetchRequest, usePrefetchedEntries } from './use-prefetched-cache.js'

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
}

export function useReferenceSeams({
  body,
  resolveAlias,
  resolveTitle,
  load = loadFromBrowser,
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
        log.warn('reference load failed', { target, err })
        return undefined
      }
    },
    [documentIdOf, load],
  )

  const cache = usePrefetchedEntries<LoadedReference>(
    useCallback(
      (loaded) =>
        referenceTargets({ bodies: [body], loaded }).map(
          (target): PrefetchRequest<LoadedReference> => ({
            key: target,
            load: () => loadEntry(target),
          }),
        ),
      [body, loadEntry],
    ),
  )

  return useMemo(
    () =>
      referenceSeams(cache, {
        ...(resolveAlias !== undefined ? { resolveAlias } : {}),
        ...(resolveTitle !== undefined ? { resolveTitle } : {}),
      }),
    [cache, resolveAlias, resolveTitle],
  )
}
