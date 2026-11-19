/**
 * The reads a recorded CRDT row is judged by, in plain JSON.
 *
 * The recorder (`scripts/record-crdt-read-oracle.ts`) and the replay
 * (`oracle/crdt-read-recorded-oracle.test.ts`) both call `readersOf`, so the
 * list of questions asked of a row lives in one place and a reader added here
 * is asked of every row the next time the recording is taken.
 *
 * A reader's refusal is part of its answer: an error is recorded as its class,
 * because the Rust replay has to refuse the same rows, and a message is the one
 * thing a port words differently.
 */
import { type Frontiers, LoroDoc, VersionVector } from 'loro-crdt'
import { readAnnotations } from '../annotations.js'
import { readCommentThreads } from '../comment-threads.js'
import type { DocumentContainers } from '../containers.js'
import { contentDigestOfDocument } from '../content-digest.js'
import { readDocumentContent } from '../document-content.js'
import {
  readCoreFacets,
  readDocumentKind,
  readFacets,
  readTrustFacets,
} from '../document-envelope.js'
import { scanFileReferences } from '../file-references.js'
import { collectImageRefIds } from '../image-refs.js'
import { readEdgeLocks, readNodeLocks, readSpatialCanvasWithSkipped } from '../loro-bridge.js'
import { readMarkdownBody } from '../markdown-body.js'
import { readProposals } from '../proposals.js'
import { documentsRemovedSince } from '../removed-documents.js'
import { retiredStoredShapeIn } from '../retired-stored-shape.js'
import { countSpatialNodes } from '../spatial-node-count.js'
import { stateSize } from '../state-size.js'
import { judgeStateWithinTextLimits } from '../sync-text-limits.js'
import { readThreadMarks } from '../thread-marks.js'
import { documentsTouchedSince, organisationChangedSince } from '../touched-documents.js'
import { readWorkspaceFolderNames } from '../workspace-folder-name.js'
import { readTrashEntries } from '../workspace-trash.js'
import {
  documentContainers,
  projectWorkspaceDocument,
  readPinnedDocumentIds,
  readWorkspaceDocuments,
  readWorkspaceMeta,
  readWorkspaceNodes,
  resolveWorkspaceDocumentById,
  unreadableWorkspaceNodes,
} from '../workspace-tree.js'

export type Answer = { ok: unknown } | { err: string }

/** `[peer, counter]` pairs, peers as decimal strings: JSON has no bigint. */
export type VersionPairs = Array<[string, number]>

/** Peers are u64 decimal strings, so they compare as numbers, not as text. */
function comparePeers(a: string, b: string): number {
  const left = BigInt(a)
  const right = BigInt(b)
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function versionPairs(version: VersionVector): VersionPairs {
  return [...version.toJSON().entries()]
    .map(([peer, counter]) => [String(peer), counter] as [string, number])
    .sort(([a], [b]) => comparePeers(a, b))
}

export function versionOfPairs(pairs: VersionPairs): VersionVector {
  return new VersionVector(new Map(pairs.map(([peer, counter]) => [peer as `${number}`, counter])))
}

export function frontierPairs(frontiers: Frontiers): Array<[string, number]> {
  return frontiers
    .map(({ peer, counter }) => [String(peer), counter] as [string, number])
    .sort(([a, x], [b, y]) => comparePeers(a, b) || x - y)
}

/** A tree id is `counter@peer`; the peer of a replica made on the way is random. */
function maskPeers(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/^(\d+)@\d+$/, '$1@*')
  if (Array.isArray(value)) return value.map(maskPeers)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskPeers(v)]))
  }
  return value
}

/**
 * JSON that keeps what JSON drops, so two answers that differ only in an
 * `undefined`, a `NaN`, a `Set` or a `Map` do not read as equal.
 */
function plain(value: unknown): unknown {
  if (value === undefined) return { $undefined: true }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : { $number: String(value) }
  if (typeof value === 'bigint') return { $bigint: String(value) }
  // Exported Loro bytes embed the exporting replica's random peer id, so two
  // honest runs differ; what they MEAN is the state they import to.
  if (value instanceof Uint8Array) {
    const held = new LoroDoc()
    held.import(value)
    return { $loroState: maskPeers(held.toJSON()) }
  }
  if (value instanceof Set) return { $set: [...value].map(plain) }
  if (value instanceof Map) return { $map: [...value].map(([k, v]) => [plain(k), plain(v)]) }
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)]),
    )
  }
  return { $unrepresentable: typeof value }
}

export function answer(read: () => unknown): Answer {
  try {
    return { ok: plain(read()) }
  } catch (error) {
    return { err: error instanceof Error ? error.constructor.name : typeof error }
  }
}

async function answerLater(read: () => Promise<unknown>): Promise<Answer> {
  try {
    return { ok: plain(await read()) }
  } catch (error) {
    return { err: error instanceof Error ? error.constructor.name : typeof error }
  }
}

/** Every read a document's own containers answer, hosted on a root or on a tree node. */
function contentReaders(host: DocumentContainers): Record<string, Answer> {
  return {
    documentKind: answer(() => readDocumentKind(host)),
    documentContent: answer(() => readDocumentContent(host)),
    spatialCanvas: answer(() => readSpatialCanvasWithSkipped(host)),
    nodeLocks: answer(() => [...readNodeLocks(host)].sort()),
    edgeLocks: answer(() => [...readEdgeLocks(host)].sort()),
    spatialNodeCount: answer(() => countSpatialNodes(host)),
    markdownBody: answer(() => readMarkdownBody(host)),
    bodyDelta: answer(() => host.getText('body').toDelta()),
    coreFacets: answer(() => readCoreFacets(host)),
    trustFacets: answer(() => readTrustFacets(host)),
    facets: answer(() => readFacets(host)),
    annotations: answer(() => readAnnotations(host)),
    commentThreads: answer(() => readCommentThreads(host)),
    threadMarks: answer(() => readThreadMarks(host)),
    proposals: answer(() => readProposals(host)),
    imageRefIds: answer(() => [...collectImageRefIds(host)].sort()),
    retiredStoredShape: answer(() => retiredStoredShapeIn(host)),
  }
}

/** A document that is the root of its own LoroDoc. */
export function rootDocumentReaders(doc: LoroDoc): Record<string, Answer> {
  return {
    ...contentReaders(doc),
    stateSize: answer(() => stateSize(doc)),
    contentDigest: answer(() => contentDigestOfDocument(doc)),
    textLimitBreach: answer(() => judgeStateWithinTextLimits(doc)),
  }
}

/** A workspace record: the tree and its planes, then each document it hosts. */
export async function workspaceReaders(
  doc: LoroDoc,
  since: VersionVector,
): Promise<Record<string, unknown>> {
  const documents = answer(() => readWorkspaceDocuments(doc))
  const ids =
    'ok' in documents
      ? (documents.ok as Array<{ documentId: string }>).map((entry) => entry.documentId)
      : []
  const perDocument: Record<string, unknown> = {}
  for (const id of ids) {
    const hosted = answer(() => contentReaders(documentContainers(doc, id)))
    perDocument[id] = hosted
    perDocument[`${id}#entry`] = answer(() => resolveWorkspaceDocumentById(doc, id))
    perDocument[`${id}#projection`] = answer(() => {
      const projected = projectWorkspaceDocument(doc, id)
      return projected === null
        ? null
        : {
            value: projected.toJSON(),
            documentContent: answer(() => readDocumentContent(projected)),
            stateSize: answer(() => stateSize(projected)),
            contentDigest: answer(() => contentDigestOfDocument(projected)),
          }
    })
  }
  return {
    documents,
    nodes: answer(() => readWorkspaceNodes(doc)),
    meta: answer(() => readWorkspaceMeta(doc)),
    pinned: answer(() => readPinnedDocumentIds(doc)),
    trash: answer(() => readTrashEntries(doc)),
    folderNames: answer(() => readWorkspaceFolderNames(doc)),
    unreadableNodes: answer(() => unreadableWorkspaceNodes(doc)),
    stateSize: answer(() => stateSize(doc)),
    textLimitBreach: answer(() => judgeStateWithinTextLimits(doc)),
    removedSince: answer(() => documentsRemovedSince(doc, since)),
    touchedSince: answer(() => documentsTouchedSince(doc, since)),
    organisationChangedSince: answer(() => organisationChangedSince(doc, since)),
    fileReferences: await answerLater(async () => {
      const scan = await scanFileReferences(doc, { trashBytes: async () => null })
      return { referenced: [...scan.referenced].sort(), unjudged: scan.unjudged }
    }),
    perDocument,
  }
}
