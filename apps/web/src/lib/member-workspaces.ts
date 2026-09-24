import { listWorkspacesResponseSchema } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'

export interface MemberWorkspace {
  readonly workspaceId: string
  /** The address a workspace may also be reached at (ADR-0019). */
  readonly segment: string | undefined
  readonly name: string
}

/**
 * The workspaces a server-mode keeper lets the signed-in person reach, or
 * `'unavailable'` when the list could not be read — an error answer fails the
 * schema like any malformed one.
 */
export async function listMemberWorkspaces(
  fetchFn: typeof globalThis.fetch,
): Promise<MemberWorkspace[] | 'unavailable'> {
  const res = await fetchFn('/api/workspaces').catch(() => null)
  const parsed = res && listWorkspacesResponseSchema.safeParse(await res.json().catch(() => null))
  if (!parsed?.success) return 'unavailable'
  return parsed.data.workspaces.map((w) => ({
    workspaceId: w.workspaceId,
    segment: w.segment,
    name: w.displayName ?? w.segment ?? w.workspaceId,
  }))
}
