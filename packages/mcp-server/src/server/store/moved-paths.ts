import { readWorkspaceNodes } from '@kamiazya/whiteboard-loro-adapter'
import { isSelfOrDescendant, rebasePath } from '@kamiazya/whiteboard-model'
import type { LoroDoc } from 'loro-crdt'
import { evictDoc } from './doc-cache.js'
import type { StoreScope } from './store-scope.js'

/**
 * Runs a subtree move and forces the next `getDoc()` to reload under every
 * cache key it touched. Both daemon stores that move documents go through it,
 * so neither can forget half of the rule.
 *
 * A SOURCE path: a caller still reading through it should lazily create a
 * fresh document rather than resurrect the moved doc's cached instance. A
 * DESTINATION path: the cache keeps no entry for a path the tree places
 * nothing at (`getOrLoad`), so there should be nothing to evict; evicting
 * anyway costs a map delete and keeps the moved document's content from
 * being shadowed should some other write that vacated the path have missed
 * its own eviction.
 *
 * The subtree is collected BEFORE `move` runs: afterwards the tree is the
 * only record of it, and it records the new paths only. `workspaceDoc` is
 * `null` for a workspace with no stored record, which has nothing to evict.
 */
export async function moveEvictingCache(
  workspaceId: string,
  from: string,
  to: string,
  scope: StoreScope,
  workspaceDoc: LoroDoc | null,
  move: () => Promise<void>,
): Promise<void> {
  const movedPaths =
    workspaceDoc === null
      ? []
      : readWorkspaceNodes(workspaceDoc)
          .map((node) => node.path)
          .filter((path) => isSelfOrDescendant(path, from))
  await move()
  for (const path of movedPaths) {
    evictDoc(workspaceId, path, scope)
    evictDoc(workspaceId, rebasePath(path, from, to), scope)
  }
}
