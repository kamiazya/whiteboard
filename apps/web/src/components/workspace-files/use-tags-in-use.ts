import { tagsInUse } from '@kamiazya/whiteboard-model'
import { useCallback, useMemo, useRef, useState } from 'react'
import type { WorkspaceDocumentEntry } from '../../lib/document-entry.js'
import type { TagInUse, WorkspaceFilesSource } from '../../lib/files-source.js'

export interface TagsInUse {
  /**
   * The vocabulary to draw, keeper's count or derived fallback — never
   * null, because a strip with nothing to show is an empty list rather
   * than a state a caller has to branch on.
   */
  readonly tags: readonly TagInUse[]
  /** Ask the keeper again. Called with every list read. */
  readonly reload: () => Promise<void>
  /** The workspace changed: the count belongs to the departed keeper. */
  readonly reset: () => void
}

/**
 * The tag vocabulary in use, as the keeper counts it (ADR-0040 decision 5).
 *
 * Reloaded with the list, so deleting the last carrier of a tag removes its
 * chip. A keeper that does not answer, or has not yet, gets the strip
 * derived from the entries' own tags — documents only, no counts of what a
 * board's boxes carry.
 */
export function useTagsInUse(
  source: WorkspaceFilesSource,
  documents: readonly WorkspaceDocumentEntry[] | null,
): TagsInUse {
  const [counted, setCounted] = useState<readonly TagInUse[] | null>(null)
  // Rows land only from the LATEST ask. The workspace-load effect and the
  // revision effect each ask, and the earlier ask can answer after the
  // later one — which would show the vocabulary from before the write that
  // bumped the revision until the next one. A counter rather than a
  // per-effect flag, since the two effects do not know about each other.
  const request = useRef(0)

  const reload = useCallback(async () => {
    const token = ++request.current
    const rows =
      source.listTagsInUse === undefined ? null : await source.listTagsInUse().catch(() => null)
    if (token === request.current) setCounted(rows)
  }, [source])

  const tags = useMemo<readonly TagInUse[]>(() => {
    if (counted !== null) return counted
    return tagsInUse(
      (documents ?? []).map((entry) => ({
        what: entry.kind === 'spatial' ? 'board' : 'document',
        tags: entry.tags ?? [],
      })),
    )
  }, [documents, counted])

  // SCOPE RESET — the panel's own scope-reset effect calls this; the marker
  // lets scoped-screen-state.test.ts verify the setters from here.
  const reset = useCallback(() => {
    setCounted(null)
  }, [])

  return { tags, reload, reset }
}
