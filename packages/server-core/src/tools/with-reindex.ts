import type { WorkspaceId } from '@kamiazya/whiteboard-canvas-model'
import { getLogger } from '../log.js'
import type { ServerDeps } from '../server-deps.js'
import { reindexWorkspace } from './reindex.js'

const log = getLogger('with-reindex')

/**
 * Wraps a mutation tool's `execute` so a successful mutation reindexes
 * the workspace afterward. Apply this INSIDE each mutation tool's
 * `createXxxTool` factory (canvas-crud, body-patch, node-patch,
 * edge-patch, facet-set, canvas-import-okf, version-restore) — never at
 * `create-server.ts`'s registration site, so a read-only tool factory
 * that never calls `withReindex` is structurally excluded from the
 * reindex side-effect rather than relying on a central allowlist.
 *
 * `workspaceId` is read generically off the input because every mutation
 * input DTO already carries it; the `{ workspaceId: WorkspaceId }`
 * constraint on `Input` makes a future mutation tool that forgets the
 * field a compile error rather than a silent skipped reindex.
 *
 * `reindexWorkspace` already swallows its own internal errors (see
 * reindex.ts — "the index is eventually consistent, not a gate on
 * mutation success"), but this wrapper guards the call anyway so that
 * invariant holds even if a future change to `reindexWorkspace` starts
 * rejecting: a reindex failure is logged, never surfaced to the caller,
 * and never changes the already-resolved mutation result.
 */
export function withReindex<Input extends { workspaceId: WorkspaceId }, Output>(
  deps: ServerDeps,
  execute: (input: Input) => Promise<Output>,
): (input: Input) => Promise<Output> {
  return async (input: Input): Promise<Output> => {
    const result = await execute(input)
    try {
      await reindexWorkspace(deps, input.workspaceId)
    } catch (err) {
      log.error('reindex after mutation failed; mutation result is unaffected', {
        workspaceId: input.workspaceId,
        err,
      })
    }
    return result
  }
}
