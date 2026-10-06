/**
 * What the offline replica page does to the replica record, as functions over
 * it — every read of a document's containers and every CRDT write the page
 * makes lives here, so a screen under `pages/` never names the CRDT.
 *
 * NOTHING here touches a document index: a data-plane edit (ADR-0023
 * decision 3) writes the record and only the record.
 */
import {
  type LoadedReference,
  type ReferenceWire,
  referenceTargets,
  referenceWire,
} from '@kamiazya/whiteboard-canvas-render'
import type { createUniqueNameResolver } from '@kamiazya/whiteboard-codec'
import type { VersionDocumentResponse } from '@kamiazya/whiteboard-daemon-client/api-contracts/document'
import {
  documentContainers,
  readDocumentContent,
  readFacets,
  readWorkspaceDocuments,
  reconcileSpatialCanvas,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import {
  readTagLibrary,
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
      ...(kind === undefined ? {} : { kind }),
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
 * The workspace's tag library as the replica holds it: what the document at
 * `tags` declares, read from the record at the same well-known path both
 * keepers read it from. Empty for a replica without one, and for one that
 * does not read — a board stays drawable when a document elsewhere is wrong.
 */
export function replicaTagLibrary(
  record: ReplicaRecord,
  entries: readonly WorkspaceDocumentEntry[],
): TagLibrary {
  const library = entries.find((entry) => entry.path === TAG_LIBRARY_PATH)
  if (library === undefined) return readTagLibrary(undefined)
  try {
    return readTagLibrary(readFacets(documentContainers(record, library.documentId)))
  } catch {
    return readTagLibrary(undefined)
  }
}

/**
 * What the selected document points at, resolved out of the replica itself.
 *
 * Seeded from what the SELECTED document says, then walked the way every
 * other keeper walks it — `referenceTargets` re-reads the graph as it grows,
 * so a referenced body's own links load too, under its own caps. Nothing here
 * reaches a keeper: every target's body or canvas is read from the same
 * record, which is what makes references work on the one page that exists
 * BECAUSE the daemon is unreachable.
 */
export function replicaReferenceWire({
  record,
  entries,
  selected,
  resolveAlias,
  resolveTitle,
}: {
  record: ReplicaRecord
  entries: readonly WorkspaceDocumentEntry[]
  selected: WorkspaceDocumentEntry
  resolveAlias: ReturnType<typeof createUniqueNameResolver>
  resolveTitle: ReturnType<typeof linkTitles>
}): ReferenceWire {
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
  const graph = new Map<string, LoadedReference | null>()
  for (;;) {
    const wanted = referenceTargets({ ...seeds, loaded: graph }).filter(
      (target) => !graph.has(target),
    )
    if (wanted.length === 0) break
    for (const target of wanted) graph.set(target, load(target))
  }
  return referenceWire(graph, { resolveAlias, resolveTitle })
}
