import {
  type ReferenceGraph,
  type ReferenceSeams,
  type ReferenceSeeds,
  referenceSeams,
  walkReferences,
} from '@kamiazya/whiteboard-canvas-render'
import type { WorkspaceId } from '@kamiazya/whiteboard-model'
import { getLogger } from '../log.js'
import type { ServerDeps } from '../server-deps.js'
import { loadReferencedDocument } from './resolve-file-references.js'

const log = getLogger('reference-graph')

export interface LoadedReferenceGraph {
  /** Every reference the seeds reach, as written, with what it loaded as. */
  readonly graph: ReferenceGraph
  /** The layout's seams over that graph — the one thing a render passes on. */
  readonly seams: ReferenceSeams
}

/**
 * Loads everything a render's seeds point at — a markdown body's links and
 * embeds, a canvas's file nodes — transitively through the markdown it
 * finds, so the layout's SYNCHRONOUS seams become map lookups. The daemon's
 * twin of apps/web's prefetching hooks: all of them walk with
 * `walkReferences` and hand `referenceSeams` what they loaded, and none
 * decides on its own what a reference is or draws as.
 *
 * Total: a target that fails to load is logged and recorded as nothing
 * there, so the reader keeps the literal text the author wrote and the
 * render never fails for a reference.
 */
export async function loadReferenceGraph(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  seeds: ReferenceSeeds,
): Promise<LoadedReferenceGraph> {
  const graph = await walkReferences(
    seeds,
    (target) => loadReferencedDocument(deps, workspaceId, target),
    {
      onFailure: (target, err) => {
        log.warning('reference did not load; rendering it unresolved', {
          workspaceId,
          target,
          err,
        })
        return null
      },
    },
  )
  return { graph, seams: referenceSeams(graph) }
}
