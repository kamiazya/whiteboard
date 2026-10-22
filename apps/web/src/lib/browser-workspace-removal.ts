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
 *   again later must be allowed to store it again. What keeps a page still
 *   holding it from writing it back is that a record is minted only under
 *   an id something here holds (`refuseUnlessHeld`).
 *
 * Whoever writes a removal path decides what dies with the copy, so a path
 * written in place at its call site is where something gets left behind.
 */
import type { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { demoteBrowserWorkspace, replicaCarriesAll } from './demote-browser-workspace.js'
import type { PromoteWorkspaceResult } from './promote-workspace.js'
import { openDocumentStore, unmarkReplica } from './replica-store.js'
import { stopReplicaReadableOffline } from './replica-unlock.js'
import { forgetReplicaEntry } from './replicas.js'
import type { UserSettingsStore } from './user-settings-store.js'
import { announceWorkspaceRemoved } from './workspace-broadcast.js'

type PromotedOutcome = Extract<PromoteWorkspaceResult, { kind: 'ok' }>

/**
 * Whether the move left nothing only the browser copy holds — deliberately
 * strict. `failed` refuses because a re-run may cure it, and the source
 * record is the retry vehicle. `missing` refuses although no re-run will: it
 * means this browser has no readable bytes for the reference — gone, or a
 * record too corrupt to parse — so the move could not carry them, and the
 * source copy is the only evidence of what the document pointed at.
 * `leftBehind` refuses because a trash entry or a saved version the daemon
 * did not confirm holding exists only in the copy a demote would delete.
 * `versionsLeftBehind` refuses for the saved versions the move chose not to
 * carry, so a demote cannot delete them even if no sentence named them.
 */
function canDemote(outcome: PromotedOutcome): boolean {
  return (
    outcome.blobs.failed.length === 0 &&
    outcome.blobs.missing.length === 0 &&
    outcome.leftBehind.length === 0 &&
    outcome.versionsLeftBehind === 0
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
async function dropReplicaCopy(
  settingsStore: Pick<UserSettingsStore, 'update'>,
  workspaceId: string,
  daemonBaseUrl: string | undefined,
): Promise<void> {
  settingsStore.update((current) => forgetReplicaEntry(current, workspaceId))
  if (daemonBaseUrl !== undefined) stopReplicaReadableOffline(daemonBaseUrl, workspaceId)
  await openDocumentStore().deleteDoc({ docRef: { kind: 'workspace-tree', workspaceId } })
}

/**
 * The person's "delete this copy". With the claim and this tab's mark gone
 * the record can no longer be minted again (`refuseUnlessHeld`), and every
 * page holding it is told, so it locks rather than finding out on its next
 * save.
 */
export async function forgetReplicaCopy(
  settingsStore: Pick<UserSettingsStore, 'update'>,
  workspaceId: string,
  daemonBaseUrl: string | undefined,
): Promise<void> {
  unmarkReplica(workspaceId)
  await dropReplicaCopy(settingsStore, workspaceId, daemonBaseUrl)
  announceWorkspaceRemoved(workspaceId)
}

/**
 * A copy sealed under a key generation the daemon replaced, dropped so the
 * pull in flight can store a fresh one. Not a removal: the pull's mark stays,
 * so its save is admitted and sealed, and no page is told — a page showing
 * the unreadable copy re-opens the pulled one on its Reconnect.
 */
export async function discardRotatedReplicaCopy(
  settingsStore: Pick<UserSettingsStore, 'update'>,
  workspaceId: string,
  daemonBaseUrl: string,
): Promise<void> {
  await dropReplicaCopy(settingsStore, workspaceId, daemonBaseUrl)
}
