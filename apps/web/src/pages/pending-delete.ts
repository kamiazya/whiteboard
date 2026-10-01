/**
 * What a document list's delete confirmation is asking about, and the two
 * answers both keepers give after a partial delete — declared once, because
 * the browser and the daemon index pages each had a copy and the copies had
 * already diverged (a lone survivor the daemon's list no longer held was
 * offered as `Delete "1 documents"?`).
 *
 * What DELETING means stays with each keeper (one DELETE and a refetch
 * against the daemon; an index call plus a pointer check in the browser).
 * Only the shape that is the same either way lives here.
 */
import type { DocumentKind } from '@kamiazya/whiteboard-model'

/**
 * A LIST, so one confirmation and one handler serve both the single delete
 * and the selection's bulk delete. A single delete is a list of one, and
 * keeps naming its document.
 */
export interface PendingDelete {
  readonly paths: readonly string[]
  readonly displayName: string
  readonly kind?: DocumentKind
}

/** How a list names one of its rows, for a dialog that has to say which. */
export type DeleteRowLookup = (
  path: string,
) => { readonly displayName: string; readonly kind?: DocumentKind } | undefined

/**
 * What the confirm dialog offers after a partial delete: exactly the ones
 * that did not go, so pressing Delete again retries those and nothing else.
 * Left un-narrowed, a retry re-sent DELETE for every path the first attempt
 * had already removed.
 *
 * A lone survivor gets its NAME back — `Delete "2 documents"?` would be the
 * count of the ATTEMPT, not of what the dialog now offers to do — and a lone
 * survivor the list no longer holds is named by its path, never counted.
 */
export function reofferFailures(failed: readonly string[], lookup: DeleteRowLookup): PendingDelete {
  const only = failed.length === 1 ? lookup(failed[0] as string) : undefined
  return {
    paths: [...failed],
    displayName:
      failed.length === 1
        ? (only?.displayName ?? (failed[0] as string))
        : `${failed.length} documents`,
    ...(only?.kind === undefined ? {} : { kind: only.kind }),
  }
}

/**
 * All of them failing reports the keeper's own reason when it gave one, else
 * the keeper's fallback sentence; some of them failing reports the count.
 */
export function partialDeleteMessage(
  failed: number,
  attempted: number,
  lastError: unknown,
  fallback: string,
): string {
  if (failed < attempted) return `${failed} of ${attempted} could not be deleted.`
  return lastError instanceof Error ? lastError.message : fallback
}

/**
 * The files panel's two delete callbacks — one row, or a selection — as the
 * one request the confirm flow takes. Both keepers' pages spread this into
 * the panel, so what a multi-select is CALLED is decided once.
 */
export function deleteRequestsFor(request: (pending: PendingDelete) => void): {
  readonly onRequestDelete: (path: string, displayName: string, kind?: DocumentKind) => void
  readonly onRequestDeleteMany: (paths: readonly string[]) => void
} {
  return {
    onRequestDelete: (path, displayName, kind) =>
      request({ paths: [path], displayName, ...(kind === undefined ? {} : { kind }) }),
    onRequestDeleteMany: (paths) =>
      request({ paths: [...paths], displayName: `${paths.length} documents` }),
  }
}
