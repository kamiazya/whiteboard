/**
 * Which namespace holds a workspace on a keeper with many people (ADR-0053):
 * its oldest owner's. Two kinds of move read that rule — a holder who stops
 * owning it or is deleted hands the workspace to the next owner (decision 4),
 * and the first owner an operator grants to a workspace held in `me` takes
 * it into their own, since no server-mode user can hold `me` and the
 * workspace would otherwise stay reachable by its id alone.
 */
import { SINGLE_PERSON_NAMESPACE, WORKSPACE_SEGMENT_MAX_LENGTH } from '@kamiazya/whiteboard-model'
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
 *
 * `handedOver` is a move its recipient did not ask for — somebody else
 * stopped owning it, or was deleted. Its segment was chosen by somebody
 * else, and a bare segment means the caller's own namespace (ADR-0053), so
 * keeping it would let that person plant a workspace under a name the
 * recipient would type for one of their own: their `journal` URL, or an
 * agent's `createWorkspace` on `journal`, would reach it and write where the
 * planter reads. So it is renamed with a tail of its id, which nobody types
 * by habit. `me` holds nobody's habits and keeps the segment.
 */
export async function moveIntoNamespace(
  trx: TenantTransaction,
  workspace: { readonly id: string; readonly segment: string | null },
  namespace: string,
  options: { readonly handedOver?: boolean } = {},
): Promise<void> {
  const taken = async (segment: string) =>
    (await trx
      .selectFrom('workspaces')
      .select('id')
      .where('namespace', '=', namespace)
      .where('segment', '=', segment)
      .where('id', '!=', workspace.id)
      .executeTakeFirst()) !== undefined
  const base =
    workspace.segment !== null &&
    options.handedOver === true &&
    namespace !== SINGLE_PERSON_NAMESPACE
      ? handedOverSegment(workspace.segment, workspace.id)
      : workspace.segment
  const segment = base === null ? null : ((await firstFreeSegment(base, taken)) ?? null)
  await trx
    .updateTable('workspaces')
    .set({ namespace, segment, updatedAt: Date.now() })
    .where('id', '=', workspace.id)
    .execute()
}

const HANDED_OVER_TAIL_LENGTH = 8

/**
 * `<segment>-<tail>`, the tail the last characters of the workspace id —
 * the random half of a ULID. Deterministic, so a second hand-over finds the
 * tail already there — collision suffix and all — and leaves the segment as
 * it is rather than growing it.
 */
function handedOverSegment(segment: string, workspaceId: string): string {
  const tail = workspaceId
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(-HANDED_OVER_TAIL_LENGTH)
  // The tail may be followed by the `-<n>` `firstFreeSegment` added when the
  // tailed segment was taken in a namespace it passed through.
  // Both forms are asked: an all-digit tail reads as a suffix itself.
  const tailed = (text: string) => text.endsWith(`-${tail}`)
  if (tail === '' || tailed(segment) || tailed(withoutCollisionSuffix(segment))) return segment
  const room = WORKSPACE_SEGMENT_MAX_LENGTH - tail.length - 1
  const head = withoutTrailingDashes(segment.slice(0, room))
  return head === '' ? tail : `${head}-${tail}`
}

// Both trims scan back from the end once. An end-anchored regex retries from
// every `-` in the string, which is quadratic in a segment of dashes or digits.

/** `segment` less one trailing `-<digits>`, or `segment` itself when it has none. */
function withoutCollisionSuffix(segment: string): string {
  let i = segment.length
  while (i > 0 && isDigit(segment.charCodeAt(i - 1))) i--
  return i < segment.length && i > 0 && segment[i - 1] === '-' ? segment.slice(0, i - 1) : segment
}

function withoutTrailingDashes(text: string): string {
  let i = text.length
  while (i > 0 && text[i - 1] === '-') i--
  return text.slice(0, i)
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
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
