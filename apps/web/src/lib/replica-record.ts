/**
 * What the offline replica page does to the replica record, as functions over
 * it — every read of a document's containers and every CRDT write the page
 * makes lives here, so a screen under `pages/` never names the CRDT.
 *
 * NOTHING here touches a document index: a data-plane edit (ADR-0023
 * decision 3) writes the record and only the record.
 */
import {
  imageTargets,
  type LoadedReference,
  type ReferenceExtra,
  type ReferenceGraph,
  type ReferenceWire,
  referenceWire,
  walkReferencesSync,
} from '@kamiazya/whiteboard-canvas-render'
import type { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import type { VersionDocumentResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import type { WorkspaceStencils } from '@kamiazya/whiteboard-facet-engine'
import {
  documentContainers,
  readDocumentContent,
  readEdgeLocks,
  readFacets,
  readNodeLocks,
  readWorkspaceDocuments,
  reconcileSpatialCanvas,
  setEdgeLock,
  setNodeLock,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { ExtensionFacets, SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  readStencilLibrary,
  readTagLibrary,
  STENCIL_LIBRARY_PATH,
  TAG_LIBRARY_PATH,
  type TagLibrary,
} from '@kamiazya/whiteboard-plugin-visual'
import type { LoroDoc } from 'loro-crdt'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import type { linkTitles } from './link-entries.js'

/** The workspace record a replica is: one CRDT holding every document. */
export type ReplicaRecord = LoroDoc

/**
 * What a selected document holds, read out of the record. The shape the
 * daemon answers a past version with, so one reader's output is assignable to
 * the other's and neither can grow a field the other lacks.
 */
export type ReplicaContent = VersionDocumentResponse

/**
 * The record's documents in the web entry type. The two agree except that
 * loro-adapter's updatedAt is a number, and the page has no use for a
 * timestamp its banner already states better.
 */
export function replicaEntries(record: ReplicaRecord): WorkspaceDocumentEntry[] {
  return readWorkspaceDocuments(record).map(
    ({ documentId, path, kind, name, shadowed }): WorkspaceDocumentEntry => ({
      documentId,
      path,
      kind,
      ...(name === undefined ? {} : { name }),
      ...(shadowed === undefined ? {} : { shadowed }),
    }),
  )
}

/** The selected document's content; the record is the source on every switch. */
export function readReplicaContent(
  record: ReplicaRecord,
  entry: Pick<WorkspaceDocumentEntry, 'documentId' | 'kind'>,
): ReplicaContent {
  return readDocumentContent(documentContainers(record, entry.documentId), entry.kind)
}

export function writeReplicaMarkdown(
  record: ReplicaRecord,
  documentId: string,
  body: string,
): void {
  writeMarkdownBody(documentContainers(record, documentId), body)
}

/**
 * A visible diff, never a whole-canvas resync: a resync's silent deletion of
 * an unknown-version record would become an op that SHIPS, erasing a newer
 * client's node on the keeper.
 */
export function writeReplicaSpatial(
  record: ReplicaRecord,
  documentId: string,
  prev: SpatialCanvas,
  next: SpatialCanvas,
): void {
  reconcileSpatialCanvas(documentContainers(record, documentId), prev, next)
}

/**
 * The canvas's locked nodes and edges. A lock is record content beside the
 * canvas, so the replica carries the daemon's locks and an offline edit is
 * held to them exactly as a live one is — without them an edit made here
 * could move or delete a locked element and ship that to the keeper.
 */
export function readReplicaLocks(
  record: ReplicaRecord,
  documentId: string,
): { nodes: ReadonlySet<string>; edges: ReadonlySet<string> } {
  const containers = documentContainers(record, documentId)
  return { nodes: readNodeLocks(containers), edges: readEdgeLocks(containers) }
}

/** Locks or unlocks one node or edge; a data-plane write, like any canvas edit. */
export function writeReplicaLock(
  record: ReplicaRecord,
  documentId: string,
  target: { node: string } | { edge: string },
  locked: boolean,
): void {
  const containers = documentContainers(record, documentId)
  if ('node' in target) setNodeLock(containers, target.node, locked)
  else setEdgeLock(containers, target.edge, locked)
}

/**
 * A workspace library document as the replica holds it, read from the record
 * at the same well-known path both keepers read it from. Read as absent for a
 * replica without one, and for one that does not read — a board stays
 * drawable when a document elsewhere is wrong.
 */
function replicaLibrary<T>(
  record: ReplicaRecord,
  entries: readonly WorkspaceDocumentEntry[],
  path: string,
  read: (facets: ExtensionFacets | undefined) => T,
): T {
  const library = entries.find((entry) => entry.path === path)
  if (library === undefined) return read(undefined)
  try {
    return read(readFacets(documentContainers(record, library.documentId)))
  } catch {
    return read(undefined)
  }
}

/** The workspace's tag library: what the document at `tags` declares. */
export function replicaTagLibrary(
  record: ReplicaRecord,
  entries: readonly WorkspaceDocumentEntry[],
): TagLibrary {
  return replicaLibrary(record, entries, TAG_LIBRARY_PATH, readTagLibrary)
}

/**
 * The workspace's stencil library: what the document at `stencils` declares.
 * The editor's registry must know a stencil to take it back off a node — one
 * it does not know is undressed down to its record alone, leaving the
 * stencil's colour and facets on the box, and that edit ships to the keeper.
 */
export function replicaStencilLibrary(
  record: ReplicaRecord,
  entries: readonly WorkspaceDocumentEntry[],
): WorkspaceStencils {
  return replicaLibrary(record, entries, STENCIL_LIBRARY_PATH, readStencilLibrary)
}

/**
 * What a picture this device holds no bytes for reads as, in place of its
 * raw `asset:` id — the cache is bounded and a fetch can fail, so a replica
 * can name an image it cannot draw.
 */
export const REPLICA_IMAGE_UNAVAILABLE = 'Image unavailable offline'

/** The selected document's reference graph, and the pictures drawing it needs. */
export interface ReplicaReferences {
  readonly graph: ReferenceGraph
  /** Every image reference the graph draws, as written (`asset:<id>`). */
  readonly images: readonly string[]
}

/**
 * What the selected document points at, resolved out of the replica itself.
 *
 * Seeded from what the SELECTED document says, then walked the way every
 * other keeper walks it (`walkReferencesSync`), so a referenced body's own
 * links load too, under the same caps. Nothing here
 * reaches a keeper: every target's body or canvas is read from the same
 * record, which is what makes references work on the one page that exists
 * BECAUSE the daemon is unreachable.
 */
export function replicaReferenceGraph({
  record,
  entries,
  selected,
  resolveAlias,
}: {
  record: ReplicaRecord
  entries: readonly WorkspaceDocumentEntry[]
  selected: WorkspaceDocumentEntry
  resolveAlias: ReturnType<typeof createUniqueNameResolver>
}): ReplicaReferences {
  const byId = new Map(entries.map((entry) => [entry.documentId, entry]))
  const load = (target: string): LoadedReference | null => {
    const entry = byId.get(resolveAlias(target) ?? target) ?? byId.get(target)
    if (entry === undefined) return null
    const content = readReplicaContent(record, entry)
    return {
      documentId: entry.documentId,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      ...(content.kind === 'spatial' ? { canvas: content.canvas } : { body: content.body }),
    }
  }
  const seed = readReplicaContent(record, selected)
  const seeds = seed.kind === 'spatial' ? { canvases: [seed.canvas] } : { bodies: [seed.body] }
  const graph = walkReferencesSync(seeds, load)
  return { graph, images: imageTargets({ ...seeds, loaded: graph }) }
}

/**
 * The graph as the wire the editors draw from. `images` maps a written image
 * reference to the URL of its cached bytes; absent while those are still being
 * read, so a picture is not called unavailable before the cache has answered.
 */
export function replicaReferenceWire({
  references,
  resolveAlias,
  resolveTitle,
  images,
}: {
  references: ReplicaReferences
  resolveAlias: ReturnType<typeof createUniqueNameResolver>
  resolveTitle: ReturnType<typeof linkTitles>
  images?: ReadonlyMap<string, string>
}): ReferenceWire {
  const extras = new Map<string, ReferenceExtra>()
  for (const ref of images === undefined ? [] : references.images) {
    const href = images?.get(ref)
    extras.set(ref, href === undefined ? { label: REPLICA_IMAGE_UNAVAILABLE } : { image: { href } })
  }
  return referenceWire(references.graph, { resolveAlias, resolveTitle, extras })
}
