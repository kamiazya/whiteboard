/**
 * The delete confirmation a document LIST runs: which paths are pending,
 * whether the delete is in flight, the refusal it is showing, and the props
 * the dialog takes. One hook for both keepers, because the two index pages
 * carried the same state machine by hand and it had already drifted.
 *
 * The keeper supplies the two things that differ: `deleteEach` (what
 * deleting a path MEANS, and which paths it refused) and `refresh` (what
 * re-reads the list the dialog stands over). Everything the keeper supplies
 * is read when Delete is PRESSED, not when the dialog opened — a page that
 * switches workspaces calls `reset` so a standing dialog cannot carry the
 * departed workspace's path to the one now on screen.
 */
import { messageOf } from '@kamiazya/whiteboard-model'
import { useCallback, useRef, useState } from 'react'
import type { DeleteDocumentsDialogProps } from '../components/document-list/DeleteDocumentsDialog.js'
import type { DestructiveActionId } from '../lib/destructive-copy.js'
import {
  type DeleteRowLookup,
  type PendingDelete,
  partialDeleteMessage,
  reofferFailures,
} from './pending-delete.js'

/** Which keeper's sentence the confirmation shows, and which fallback it reports. */
export type DeleteKeeper = 'browser' | 'daemon'

const FALLBACK: Record<DeleteKeeper, string> = {
  browser: 'Failed to delete the document from this browser.',
  daemon: 'Failed to delete document.',
}

export interface UseDeleteDocumentsOptions {
  readonly keeper: DeleteKeeper
  /**
   * Delete each path, recording rather than throwing on the ones that will
   * not go: one refused path must not abandon the rest, and the person has
   * to be told how many did not. `lastError` is what an all-failed message
   * quotes when it is an Error; `null` reports the keeper's fallback.
   */
  readonly deleteEach: (
    paths: readonly string[],
  ) => Promise<{ readonly failed: readonly string[]; readonly lastError: unknown }>
  /** How the list names a row, so a re-offered survivor is named not counted. */
  readonly lookup: DeleteRowLookup
  /**
   * Re-read the list after an attempt settled. Called after a partial
   * failure too, with the dialog still open: the ones that went are gone,
   * and a list still showing them behind the dialog contradicts the count
   * above it.
   */
  readonly refresh: () => void | Promise<void>
  /** Runs after the person dismisses the dialog (never after `reset`). */
  readonly onDismiss?: () => void
}

export interface DeleteDocumentsState {
  readonly requestDelete: (pending: PendingDelete) => void
  /** The page's own clear — a workspace switch — with no dismiss hook. */
  readonly reset: () => void
  /** Spread straight into `DeleteDocumentsDialog`; a test may also await the confirm. */
  readonly dialog: Omit<DeleteDocumentsDialogProps, 'onConfirm'> & {
    readonly onConfirm: () => Promise<void>
  }
}

/** What the dialog says it is about: the name, the kind, and a count for a bulk. */
function dialogSubject(pending: PendingDelete | null): DeleteDocumentsDialogProps['pending'] {
  if (pending === null) return null
  return {
    displayName: pending.displayName,
    ...(pending.kind === undefined ? {} : { kind: pending.kind }),
    ...(pending.paths.length > 1 ? { count: pending.paths.length } : {}),
  }
}

/**
 * One press of Delete: what the dialog holds afterwards. Held open on the
 * survivors when some did not go, because the list behind it has already
 * changed and closing silently would read as "all deleted"; held open on
 * the same request when the delete itself threw.
 */
async function attempt(
  { keeper, deleteEach, lookup, refresh }: UseDeleteDocumentsOptions,
  pending: PendingDelete,
): Promise<{ pending: PendingDelete | null; error: string | null }> {
  try {
    const { failed, lastError } = await deleteEach(pending.paths)
    await refresh()
    if (failed.length === 0) return { pending: null, error: null }
    return {
      pending: reofferFailures(failed, lookup),
      error: partialDeleteMessage(failed.length, pending.paths.length, lastError, FALLBACK[keeper]),
    }
  } catch (err) {
    // daemon-api-client errors are already sanitized (problem-details title
    // or a generic status message), and the browser's are its own.
    return { pending, error: messageOf(err, FALLBACK[keeper]) }
  }
}

/** Which keeper's sentence the dialog shows, singular or bulk. */
function actionFor(keeper: DeleteKeeper, pending: PendingDelete | null): DestructiveActionId {
  const bulk = pending !== null && pending.paths.length > 1
  return bulk ? `delete-documents-${keeper}` : `delete-document-${keeper}`
}

export function useDeleteDocuments(options: UseDeleteDocumentsOptions): DeleteDocumentsState {
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const generation = useRef(0)

  // SCOPE RESET — both name the paths the dialog was opened for, and a page
  // that switches workspaces calls this from its own scope-reset effect, so
  // neither may outlive the workspace it is about. scoped-screen-state.test.ts
  // reads this block by that marker. The generation bump makes an attempt
  // still in flight drop its outcome: a partial failure settling after the
  // switch would otherwise re-open the dialog with the DEPARTED workspace's
  // paths, and the next confirm would send them to the one now on screen.
  const reset = useCallback(() => {
    generation.current += 1
    setPendingDelete(null)
    setDeleteError(null)
  }, [])

  const onCancel = useCallback(() => {
    reset()
    options.onDismiss?.()
  }, [reset, options.onDismiss])

  const onConfirm = useCallback(async (): Promise<void> => {
    if (!pendingDelete) return
    const started = generation.current
    setDeleting(true)
    setDeleteError(null)
    const outcome = await attempt(options, pendingDelete)
    setDeleting(false)
    if (started !== generation.current) return
    setPendingDelete(outcome.pending)
    setDeleteError(outcome.error)
  }, [options, pendingDelete])

  return {
    requestDelete: setPendingDelete,
    reset,
    dialog: {
      pending: dialogSubject(pendingDelete),
      busy: deleting,
      error: deleteError,
      action: actionFor(options.keeper, pendingDelete),
      onCancel,
      onConfirm,
    },
  }
}
