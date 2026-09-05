import {
  type LoadedReference,
  type ReferenceGraph,
  type ReferenceSeams,
  referenceSeams,
  referenceTargets,
} from '@kamiazya/whiteboard-canvas-render'
import type { SpatialCanvas, WorkspaceId } from '@kamiazya/whiteboard-model'
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
 * twin of apps/web's prefetching hooks: both ask `referenceTargets` what to
 * load and hand `referenceSeams` what they loaded, and neither decides on
 * its own what a reference is or draws as.
 *
 * Total: a target that fails to load is logged and recorded as nothing
 * there, so the reader keeps the literal text the author wrote and the
 * render never fails for a reference.
 */
export async function loadReferenceGraph(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
  seeds: { readonly bodies?: readonly string[]; readonly canvases?: readonly SpatialCanvas[] },
): Promise<LoadedReferenceGraph> {
  const graph = new Map<string, LoadedReference | null>()
  for (;;) {
    const wanted = referenceTargets({ ...seeds, loaded: graph }).filter(
      (target) => !graph.has(target),
    )
    if (wanted.length === 0) break
    await Promise.all(
      wanted.map(async (target) => {
        try {
          graph.set(target, await loadReferencedDocument(deps, workspaceId, target))
        } catch (err) {
          log.warning('reference did not load; rendering it unresolved', {
            workspaceId,
            target,
            err,
          })
          graph.set(target, null)
        }
      }),
    )
  }
  return { graph, seams: referenceSeams(graph) }
}
