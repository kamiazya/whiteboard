import type {
  BranchMeta,
  BranchStatsResponse,
  CreateBranchRequest,
  DeleteBranchResponse,
  MergeResponse,
  RenameBranchResponse,
  SetHeadResponse,
} from '@kamiazya/whiteboard-mcp/api-contracts'
import { type BranchesState, branchesApi } from '../hooks/useBranches.js'

/**
 * A document's branches as the UI reads and writes them — the seam between
 * the branch chip, the merge banner and the history panel's mini-graph, and
 * whoever KEEPS the workspace.
 *
 * Unlike `VersionsBackend`, the two keepers here are not near-peers: the
 * daemon has branches and the browser has none, which `provider.ts` already
 * declares as a capability. So this seam is not how that difference gets
 * decided — it is how the difference stops being enforced by REMEMBERING.
 *
 * Before it, `useBranches` built the daemon's document route as a template
 * string and called `apiFetch`, gated by an `enabled` flag that defaults to
 * ON. (Named in words rather than written out: `web-api-paths-mounted` scans
 * apps/web for API path literals WITHOUT skipping comments, so a pseudo-path
 * in prose reaches it as a route the daemon fails to mount — including, when
 * this comment first tried to explain that, the fragment it quoted.)
 * Three consumers; one passed the flag. The other two were saved by where
 * they are mounted — a `branchesEnabled &&` in the top bar, and living only
 * on the daemon page — which is a property of today's tree rather than
 * anything a compiler could hold. A fourth consumer that forgot would fall
 * toward issuing the request.
 *
 * With a keeper-shaped backend the safe answer is the DEFAULT: forgetting
 * yields the resting state, not a request to a daemon that is not there.
 */
export interface BranchesBackend {
  /**
   * Whether this keeper has branches at all — declared by the backend rather
   * than passed by each caller.
   *
   * It replaces an `enabled` flag that `useBranches` took as an argument,
   * which is the same fact in the place least able to hold it: three
   * consumers, one of which passed it, and a default of ON. A keeper knows
   * this about itself and cannot forget to mention it.
   *
   * Consumers use it for the resting presentation — a panel whose keeper has
   * no branches must not spin waiting for a list that will be empty — and NOT
   * as permission to skip `list`, which answers correctly either way.
   */
  readonly hasBranches: boolean
  list(workspaceId: string, path: string): Promise<BranchesState>
  create(workspaceId: string, path: string, args: CreateBranchRequest): Promise<BranchMeta>
  remove(workspaceId: string, path: string, name: string): Promise<DeleteBranchResponse>
  rename(
    workspaceId: string,
    path: string,
    oldName: string,
    newName: string,
  ): Promise<RenameBranchResponse>
  setHead(workspaceId: string, path: string, branch: string): Promise<SetHeadResponse>
  getStats(workspaceId: string, path: string, name: string): Promise<BranchStatsResponse>
  merge(
    workspaceId: string,
    path: string,
    source: string,
    args: { into: string; dryRun?: boolean },
  ): Promise<MergeResponse>
}

/**
 * A keeper was asked for something it does not have.
 *
 * Typed rather than a bare `Error` so a caller can tell it from the
 * structured `{ status, body }` a daemon refusal throws: one means "this
 * keeper cannot do that at all", the other "the daemon said no this time".
 * Conflating them is how a permanent absence gets a retry button.
 */
export class BranchesUnsupportedError extends Error {
  constructor(what: string) {
    super(`this keeper has no branches: ${what}`)
    this.name = 'BranchesUnsupportedError'
  }
}

/** The daemon's branches, over its document routes. */
export function createDaemonBranchesBackend(fetchFn: typeof globalThis.fetch): BranchesBackend {
  // `branchesApi` is per-document, so each method builds its own. It is a
  // stateless wrapper over URL construction; the hook already rebuilt it on
  // every dependency change for the same reason.
  const api = (workspaceId: string, path: string) => branchesApi(workspaceId, path, fetchFn)
  return {
    hasBranches: true,
    list: (workspaceId, path) => api(workspaceId, path).list(),
    create: (workspaceId, path, args) => api(workspaceId, path).create(args),
    remove: (workspaceId, path, name) => api(workspaceId, path).remove(name),
    rename: (workspaceId, path, oldName, newName) =>
      api(workspaceId, path).rename(oldName, newName),
    setHead: (workspaceId, path, branch) => api(workspaceId, path).setHead(branch),
    getStats: (workspaceId, path, name) => api(workspaceId, path).getStats(name),
    merge: (workspaceId, path, source, args) => api(workspaceId, path).merge(source, args),
  }
}

/**
 * The browser keeper, which has no branches.
 *
 * `list` answers the RESTING STATE rather than throwing, because a panel that
 * reads `head` to draw its mini-graph wants an answer, not an error to log
 * and ignore. The mutators refuse, because a caller that got here is offering
 * an action this keeper cannot perform and silently succeeding would be worse
 * than saying so.
 */
export function createBrowserBranchesBackend(): BranchesBackend {
  const refuse = (what: string) => Promise.reject(new BranchesUnsupportedError(what))
  return {
    hasBranches: false,
    list: () => Promise.resolve({ branches: [], head: 'main' }),
    create: () => refuse('create'),
    remove: () => refuse('delete'),
    rename: () => refuse('rename'),
    setHead: () => refuse('switch'),
    getStats: () => refuse('stats'),
    merge: () => refuse('merge'),
  }
}
