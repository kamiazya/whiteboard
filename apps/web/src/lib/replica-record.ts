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
  type ReferenceSeeds,
  type ReferenceWire,
  referenceWire,
  walkReferencesSync,
} from '@kamiazya/whiteboard-canvas-render'
import type { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import type { VersionDocumentResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import type { WorkspaceStencils } from '@kamiazya/whiteboard-facet-engine'
import { lease, type RecordLease, workspaceNodeMetaSchema } from '@kamiazya/whiteboard-loro-adapter'
import {
  type DocumentKind,
  type ExtensionFacets,
  type SpatialCanvas,
  tagsInUse,
} from '@kamiazya/whiteboard-model'
import {
  readStencilLibrary,
  readTagLibrary,
  STENCIL_LIBRARY_PATH,
  TAG_LIBRARY_PATH,
  type TagLibrary,
} from '@kamiazya/whiteboard-plugin-visual'
import { tagBearersOf } from '@kamiazya/whiteboard-reference-graph'
import { z } from 'zod'
import type { WorkspaceDocumentEntry } from './document-entry.js'
import type { linkTitles } from './link-entries.js'

/**
 * The workspace record a replica is: one CRDT holding every document, held as
 * an engine lease. The reads here answer at once because the page draws from
 * them while rendering; whoever opened the record releases it.
 */
export type ReplicaRecord = RecordLease

// Deliberately a type assertion and not a parse: the reader is total over the
// shape (`readDocumentContent`), and a parse would strip fields a newer
// writer added to a canvas node, which an edit here would then ship back.
const contentShape = z.custom<ReplicaContent>()
const lockIds = z.array(z.string())
const documentEntries = z.array(
  workspaceNodeMetaSchema
    .pick({ documentId: true, kind: true, name: true })
    .extend({ path: z.string(), shadowed: z.literal(true).optional() }),
)
const documentFacets = z.custom<ExtensionFacets | undefined>()
const documentTags = z
  .object({ tags: z.array(z.string()).optional() })
  .passthrough()
  .nullish()

/** A named read of one document's own containers, answered at once. */
function readDocument<T>(
  record: ReplicaRecord,
  documentId: string,
  query: 'documentContent' | 'nodeLocks' | 'edgeLocks' | 'facets' | 'coreFacets',
  shape: z.ZodType<T>,
  kind?: DocumentKind,
): T {
  return lease.readNow(
    record,
    { query, args: kind === undefined ? { documentId } : { documentId, kind } },
    shape,
  )
}

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
  return lease.readNow(record, { query: 'documents' }, documentEntries).map(
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
  return readDocument(record, entry.documentId, 'documentContent', contentShape, entry.kind)
}

function writeToDocument(record: ReplicaRecord, batch: Parameters<typeof lease.write>[1]): void {
  // The keeper this replica came from judges what it is pushed, so the write
  // makes no judging copy of a record that can be the whole workspace.
  lease.write(record, batch, { judge: 'none' })
}

export function writeReplicaMarkdown(
  record: ReplicaRecord,
  documentId: string,
  body: string,
): void {
  writeToDocument(record, [{ op: 'writeMarkdownBody', args: { documentId, body } }])
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
  writeToDocument(record, [{ op: 'reconcileSpatialCanvas', args: { documentId, prev, next } }])
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
  return {
    nodes: new Set(readDocument(record, documentId, 'nodeLocks', lockIds)),
    edges: new Set(readDocument(record, documentId, 'edgeLocks', lockIds)),
  }
}

/** Locks or unlocks one node or edge; a data-plane write, like any canvas edit. */
export function writeReplicaLock(
  record: ReplicaRecord,
  documentId: string,
  target: { node: string } | { edge: string },
  locked: boolean,
): void {
  writeToDocument(record, [
    'node' in target
      ? { op: 'setNodeLock', args: { documentId, id: target.node, locked } }
      : { op: 'setEdgeLock', args: { documentId, id: target.edge, locked } },
  ])
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
    return read(readDocument(record, library.documentId, 'facets', documentFacets))
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
 * Every tag the workspace uses, for completions — what both keepers answer as
 * their in-use list, counted the way they count it: each document projected
 * out of the record the way the daemon loads one, its bearers read by
 * `tagBearersOf` and reduced by `tagsInUse`, so the replica cannot offer a
 * different vocabulary than the keeper it stands in for.
 */
export function replicaTagsInUse(
  record: ReplicaRecord,
  entries: readonly WorkspaceDocumentEntry[],
): string[] {
  const bearers = entries.flatMap((entry) => {
    const content = readReplicaContent(record, entry)
    const tags =
      content.kind === 'markdown' ? readDocumentTags(record, entry.documentId) : undefined
    return tagBearersOf(tags === undefined ? { content } : { content, tags })
  })
  return tagsInUse(bearers).map((row) => row.tag)
}

/** A markdown document's frontmatter tags; a spatial document's own are on its canvas. */
function readDocumentTags(
  record: ReplicaRecord,
  documentId: string,
): readonly string[] | undefined {
  return readDocument(record, documentId, 'coreFacets', documentTags)?.tags
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
  /** What the selected document writes, so its links past the loading budget resolve too. */
  readonly seeds: ReferenceSeeds
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
  return { graph, seeds, images: imageTargets({ ...seeds, loaded: graph }) }
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
  return referenceWire(references.graph, {
    resolveAlias,
    resolveTitle,
    extras,
    seeds: references.seeds,
  })
}
