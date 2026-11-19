/**
 * The reads a recorded CRDT row is judged by, in plain JSON.
 *
 * The recorder (`scripts/record-crdt-read-oracle.ts`) and the replay
 * (`oracle/crdt-read-recorded-oracle.test.ts`) both ask the engine's reader
 * table (`engine/readers.ts`), so the list of questions asked of a row lives in
 * one place and a reader added there is asked of every row the next time the
 * recording is taken.
 *
 * A reader's refusal is part of its answer: an error is recorded as its class,
 * because the Rust replay has to refuse the same rows, and a message is the one
 * thing a port words differently.
 */
import type { LoroDoc, VersionVector } from 'loro-crdt'
import { type Answer, answer, versionPairs } from '../engine/answers.js'
import { CONTENT_QUERIES, READERS, readQuery } from '../engine/readers.js'
import { documentContainers } from '../workspace-tree.js'

export {
  type Answer,
  answer,
  frontierPairs,
  type VersionPairs,
  versionOfPairs,
  versionPairs,
} from '../engine/answers.js'

/** Every read a document's own containers answer, hosted on a root or on a tree node. */
function contentReaders(doc: LoroDoc, documentId?: string): Record<string, Answer> {
  const args = documentId === undefined ? {} : { documentId }
  return Object.fromEntries(
    CONTENT_QUERIES.map((name) => [name, answer(() => READERS[name](doc, args))]),
  )
}

/** A document that is the root of its own LoroDoc. */
export function rootDocumentReaders(doc: LoroDoc): Record<string, Answer> {
  const args = {}
  return {
    ...contentReaders(doc),
    stateSize: answer(() => READERS.stateSize(doc, args)),
    contentDigest: answer(() => READERS.contentDigest(doc, args)),
    textLimitBreach: answer(() => READERS.textLimitBreach(doc, args)),
  }
}

/** A workspace record: the tree and its planes, then each document it hosts. */
export async function workspaceReaders(
  doc: LoroDoc,
  since: VersionVector,
): Promise<Record<string, unknown>> {
  const sinceArgs = { since: versionPairs(since) }
  const read = (name: keyof typeof READERS, args = {}) => answer(() => READERS[name](doc, args))
  const documents = read('documents')
  const ids =
    'ok' in documents
      ? (documents.ok as Array<{ documentId: string }>).map((entry) => entry.documentId)
      : []
  const perDocument: Record<string, unknown> = {}
  for (const id of ids) {
    const named = { documentId: id }
    perDocument[id] = answer(() => {
      documentContainers(doc, id)
      return contentReaders(doc, id)
    })
    perDocument[`${id}#entry`] = read('workspaceDocumentEntry', named)
    perDocument[`${id}#projection`] = read('workspaceDocumentProjection', named)
  }
  return {
    documents,
    nodes: read('nodes'),
    meta: read('meta'),
    pinned: read('pinned'),
    trash: read('trash'),
    folderNames: read('folderNames'),
    unreadableNodes: read('unreadableNodes'),
    stateSize: read('stateSize'),
    textLimitBreach: read('textLimitBreach'),
    removedSince: read('removedSince', sinceArgs),
    touchedSince: read('touchedSince', sinceArgs),
    organisationChangedSince: read('organisationChangedSince', sinceArgs),
    fileReferences: await readQuery(doc, { query: 'fileReferences' }),
    perDocument,
  }
}
