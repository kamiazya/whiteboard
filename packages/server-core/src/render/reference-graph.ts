import {
  type ReferenceGraph,
  type ReferenceSeams,
  type ReferenceSeeds,
  type ReferenceWire,
  type ReferenceWireOptions,
  referenceSeamsFromWire,
  referenceWire,
  walkReferences,
} from '@kamiazya/whiteboard-canvas-render'
import { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import type { WorkspaceId } from '@kamiazya/whiteboard-model'
import { getLogger } from '../log.js'
import type { ServerDeps } from '../server-deps.js'
import { createReferencedDocumentLoader } from './resolve-file-references.js'

const log = getLogger('reference-graph')

export interface LoadedReferenceGraph {
  /** Every reference the seeds reach, as written, with what it loaded as. */
  readonly graph: ReferenceGraph
  /**
   * The graph as data, with the workspace's alias and title answers for
   * every target the seeds and the loaded records write — past the loading
   * budget too.
   */
  readonly wire: ReferenceWire
  /** The layout's seams over that wire — the one thing a render passes on. */
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
  const graph = await walkReferences(seeds, createReferencedDocumentLoader(deps, workspaceId), {
    onFailure: (target, err) => {
      log.warning('reference did not load; rendering it unresolved', {
        workspaceId,
        target,
        err,
      })
      return null
    },
  })
  // REFERENCE_BUDGET bounds what the walk LOADS; a link the index can
  // resolve needs no load, so the wire asks the index's tables of every
  // target the seeds write and link 300 draws titled like link 1. Through
  // the wire so the Rust core is handed the bundle as data.
  const tables = graph.size === 0 ? {} : await indexTables(deps, workspaceId)
  const wire = referenceWire(graph, { ...tables, seeds })
  return { graph, wire, seams: referenceSeamsFromWire(wire) }
}

/**
 * The workspace's alias and title tables, from ONE listing of the index and
 * no document read: a `[[path]]` resolves by the reader's rule (a path, or a
 * document id, which names itself — the codec's unique-name resolver over
 * paths, as the web keeper and the backlinks aggregate resolve), and a
 * document is titled `name ?? path`, as the walk's loader names one. Total:
 * a listing that fails leaves the links the walk loaded resolved, and no
 * others.
 */
async function indexTables(
  deps: ServerDeps,
  workspaceId: WorkspaceId,
): Promise<Pick<ReferenceWireOptions, 'resolveAlias' | 'resolveTitle'>> {
  try {
    const entries = await deps.documentIndex.listDocuments({ workspaceId })
    return {
      resolveAlias: createUniqueNameResolver(
        entries.map((entry) => ({ id: entry.documentId, name: entry.path })),
      ),
      resolveTitle: titleTable(entries),
    }
  } catch (err) {
    log.warning('workspace listing failed; links past the loaded ones render unresolved', {
      workspaceId,
      err,
    })
    return {}
  }
}

/** A listing's titles as a table input to the wire, `name ?? path` by id. */
function titleTable(
  entries: readonly { documentId: string; path: string; name?: string | undefined }[],
): (documentId: string) => string | undefined {
  const titles = new Map(entries.map((entry) => [entry.documentId, entry.name ?? entry.path]))
  return (documentId) => titles.get(documentId)
}
