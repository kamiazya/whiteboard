import { workspacesApiUrl } from '@kamiazya/whiteboard-daemon-client/api-contracts/daemon-urls'
import {
  type ListWorkspacesResponse,
  listWorkspacesResponseSchema,
} from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import { readDaemonJson } from './daemon-contract-error.js'

export interface MemberWorkspace {
  readonly workspaceId: string
  /** The address a workspace may also be reached at (ADR-0019). */
  readonly segment: string | undefined
  readonly name: string
}

/**
 * The workspaces a server-mode keeper lets the signed-in person reach, or
 * `'unavailable'` when the list could not be read. Every cause folds into that
 * one answer, since the shell offers the same retry for each — but a list that
 * arrived and broke its contract is still logged by the shared reader.
 */
export async function listMemberWorkspaces(
  fetchFn: typeof globalThis.fetch,
): Promise<MemberWorkspace[] | 'unavailable'> {
  const listed = await readMemberList(fetchFn).catch(() => 'unavailable' as const)
  if (listed === 'unavailable') return listed
  return listed.workspaces.map((w) => ({
    workspaceId: w.workspaceId,
    segment: w.segment,
    name: w.displayName ?? w.segment ?? w.workspaceId,
  }))
}

async function readMemberList(
  fetchFn: typeof globalThis.fetch,
): Promise<ListWorkspacesResponse | 'unavailable'> {
  const res = await fetchFn(workspacesApiUrl())
  if (!res.ok) return 'unavailable'
  return readDaemonJson(workspacesApiUrl(), res, listWorkspacesResponseSchema)
}
