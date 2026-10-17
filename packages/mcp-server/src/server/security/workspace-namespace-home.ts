/**
 * Which namespace holds a workspace on a keeper with many people (ADR-0053):
 * its oldest owner's. Two moves read that rule — the holder's deletion hands
 * the workspace to the next owner (decision 4), and the first owner an
 * operator grants to a workspace held in `me` takes it into their own, since
 * no server-mode user can hold `me` and the workspace would otherwise stay
 * reachable by its id alone.
 */
import { SINGLE_PERSON_NAMESPACE } from '@kamiazya/whiteboard-model'
import { firstFreeSegment } from '@kamiazya/whiteboard-workspace-index'
import {
  inTenantTransaction,
  type TenantScoped,
  type TenantTransaction,
} from '../store/db/tenant-database.js'

/**
 * The handle of the workspace's oldest owner, by membership createdAt and
 * then user id — the membership row's time, since no role-change time is
 * stored — leaving out `excluding`. `me` when no owner is left.
 */
export async function oldestOwnerNamespace(
  trx: TenantTransaction,
  workspaceId: string,
  excluding?: string,
): Promise<string> {
  let query = trx
    .selectFrom('workspaceMemberships')
    .innerJoin('memberProfiles', 'memberProfiles.id', 'workspaceMemberships.profileId')
    .select('memberProfiles.handle')
    .where('workspaceMemberships.workspaceId', '=', workspaceId)
    .where('workspaceMemberships.role', '=', 'owner')
  if (excluding !== undefined)
    query = query.where('workspaceMemberships.profileId', '!=', excluding)
  const row = await query
    .orderBy('workspaceMemberships.createdAt', 'asc')
    .orderBy('workspaceMemberships.profileId', 'asc')
    .limit(1)
    .executeTakeFirst()
  return row?.handle ?? SINGLE_PERSON_NAMESPACE
}

/**
 * Moves a workspace into `namespace`. A segment that namespace already holds
 * is suffixed there; its holder sees all of it, so the suffix tells nobody
 * anything. Past the suffix series' bound the workspace keeps no segment and
 * is reached by its id.
 */
export async function moveIntoNamespace(
  trx: TenantTransaction,
  workspace: { readonly id: string; readonly segment: string | null },
  namespace: string,
): Promise<void> {
  const taken = async (segment: string) =>
    (await trx
      .selectFrom('workspaces')
      .select('id')
      .where('namespace', '=', namespace)
      .where('segment', '=', segment)
      .where('id', '!=', workspace.id)
      .executeTakeFirst()) !== undefined
  const segment =
    workspace.segment === null ? null : ((await firstFreeSegment(workspace.segment, taken)) ?? null)
  await trx
    .updateTable('workspaces')
    .set({ namespace, segment, updatedAt: Date.now() })
    .where('id', '=', workspace.id)
    .execute()
}

/** Takes a workspace held in `me` into its oldest owner's namespace, once it has one. */
export async function homeWithItsOwner(db: TenantScoped, workspaceId: string): Promise<void> {
  await inTenantTransaction(db, async (trx) => {
    const workspace = await trx
      .selectFrom('workspaces')
      .select(['id', 'namespace', 'segment'])
      .where('id', '=', workspaceId)
      .executeTakeFirst()
    if (workspace?.namespace !== SINGLE_PERSON_NAMESPACE) return
    await moveIntoNamespace(trx, workspace, await oldestOwnerNamespace(trx, workspaceId))
  })
}
