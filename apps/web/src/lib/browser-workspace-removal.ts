/**
 * Every way a workspace's copy leaves this browser, decided in one place.
 *
 * Two kinds of copy, and they die differently:
 *
 * - a workspace this browser KEEPS leaves only after a verified move to a
 *   daemon (`demoteWhenSafe`). The gate is here; the deletion's shape — the
 *   record, the registry row, the tombstone and the residue only that
 *   record named — is `demote-browser-workspace.ts`.
 * - a REPLICA of a daemon workspace is a cache (`forgetReplicaCopy`). It
 *   takes no tombstone: the daemon still keeps the workspace, and pulling it
 *   again later must be allowed to store it again.
 *
 * Whoever writes a removal path decides what dies with the copy, so a path
 * written in place at its call site is where something gets left behind.
 */
import type { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { demoteBrowserWorkspace, replicaCarriesAll } from './demote-browser-workspace.js'
import type { PromoteWorkspaceResult } from './promote-workspace.js'
import { openDocumentStore } from './replica-store.js'
import { stopReplicaReadableOffline } from './replica-unlock.js'
import { forgetReplicaEntry } from './replicas.js'
import type { UserSettingsStore } from './user-settings-store.js'

type PromotedOutcome = Extract<PromoteWorkspaceResult, { kind: 'ok' }>

/**
 * Whether the move left nothing only the browser copy holds — deliberately
 * strict. `missing` refuses alongside `failed` because the file store folds
 * read errors into "missing", so those references may be retryable and the
 * source record is the retry vehicle. `leftBehind` refuses for the same
 * reason: a trash entry or a saved version the daemon did not confirm
 * holding exists only in the copy a demote would delete.
 */
export function canDemote(outcome: PromotedOutcome): boolean {
  return (
    outcome.blobs.failed.length === 0 &&
    outcome.blobs.missing.length === 0 &&
    outcome.leftBehind.length === 0
  )
}

/**
 * Deletes the moved workspace's browser copy when the move left nothing
 * behind AND the replica read back from this browser's own store carries
 * every promoted document. Answers whether it was deleted.
 */
export async function demoteWhenSafe(
  workspaceDocs: BrowserWorkspaceDocs,
  daemonWorkspaceId: string,
  outcome: PromotedOutcome,
): Promise<boolean> {
  if (!canDemote(outcome)) return false
  const ids = outcome.promotedDocumentIds
  if (!(await replicaCarriesAll(workspaceDocs, daemonWorkspaceId, ids))) return false
  await demoteBrowserWorkspace(outcome.sourceWorkspaceId)
  return true
}

/**
 * Deletes a cached replica: the registry claim first, the bytes second. A
 * failure between the two leaves bytes nothing points at, which the next
 * pull overwrites; the reverse leaves a claim pointing at a record that is
 * gone, and every reader of it has to cope. The wrapped key goes with the
 * claim — a key on disk for a copy that is gone opens nothing.
 */
export async function forgetReplicaCopy(
  settingsStore: Pick<UserSettingsStore, 'update'>,
  workspaceId: string,
  daemonBaseUrl: string | undefined,
): Promise<void> {
  settingsStore.update((current) => forgetReplicaEntry(current, workspaceId))
  if (daemonBaseUrl !== undefined) stopReplicaReadableOffline(daemonBaseUrl, workspaceId)
  await openDocumentStore().deleteDoc({ docRef: { kind: 'workspace-tree', workspaceId } })
}
