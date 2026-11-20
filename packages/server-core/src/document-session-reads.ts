import type { ContentWithTags, DocumentContent } from '@kamiazya/whiteboard-loro-adapter'
import type {
  CommentThread,
  DocumentKind,
  ExtensionFacets,
  Proposal,
  SpatialCanvas,
  StoredCoreFacets,
  TrustFacets,
} from '@kamiazya/whiteboard-model'
import { z } from 'zod'
import type { DocumentSession } from './document-session.js'
import { getLogger } from './log.js'

const log = getLogger('document-session')

// The engine's reads answer the value the adapter's own readers produce, and
// the contract leaves an answer any-value, so each shape asserts a type and
// parses nothing, deliberately: a parse would strip a field a newer writer
// stored.
const asserted = <T>() => z.custom<T>()
const canvasShape = asserted<{ readonly canvas: SpatialCanvas; readonly skipped: number }>()
const kindShape = asserted<DocumentKind | undefined>()
const threadsShape = asserted<CommentThread[]>()
const proposalsShape = asserted<Proposal[]>()
const facetsShape = asserted<ExtensionFacets>()
const coreShape = asserted<StoredCoreFacets | undefined>()
const trustShape = asserted<TrustFacets | undefined>()
const contentShape = asserted<ContentWithTags>()
const documentContentShape = asserted<DocumentContent>()

export const kindOf = (session: DocumentSession) =>
  session.read({ query: 'documentKind' }, kindShape)
export const markdownBodyOf = (session: DocumentSession) =>
  session.read({ query: 'markdownBody' }, z.string())
export const annotationsOf = (session: DocumentSession) =>
  session.read({ query: 'annotations' }, threadsShape)
export const proposalsOf = (session: DocumentSession) =>
  session.read({ query: 'proposals' }, proposalsShape)
export const facetsOf = (session: DocumentSession) => session.read({ query: 'facets' }, facetsShape)
export const coreFacetsOf = (session: DocumentSession) =>
  session.read({ query: 'coreFacets' }, coreShape)
export const trustFacetsOf = (session: DocumentSession) =>
  session.read({ query: 'trustFacets' }, trustShape)

/** Content and tags in one read; `kind` is the index row's, for a document that recorded none. */
export const contentOf = (session: DocumentSession, kind: DocumentKind | undefined) =>
  session.read(
    { query: 'documentContentWithTags', args: kind === undefined ? {} : { kind } },
    contentShape,
  )

/** The document's canvas and how many stored records its schema refused. */
export const spatialCanvasOf = (session: DocumentSession) =>
  session.read({ query: 'spatialCanvas' }, canvasShape)

/**
 * The document's canvas. Records its schema refuses are left out of the answer
 * and warned about: the cause is not knowable here (a field a newer client
 * wrote and a record an older writer stored past a limit fail the same
 * schema), so this states the fact and leaves the diagnosis to the reader of
 * the record.
 */
export async function canvasOf(session: DocumentSession): Promise<SpatialCanvas> {
  const { canvas, skipped } = await spatialCanvasOf(session)
  if (skipped > 0) {
    log.warning('canvas holds records that failed validation; they are left as stored', {
      workspaceId: session.workspaceId,
      documentId: session.documentId,
      skipped,
    })
  }
  return canvas
}

const idsShape = z.array(z.string())

/** The ids of the nodes the document locks. */
export async function nodeLocksOf(session: DocumentSession): Promise<ReadonlySet<string>> {
  return new Set(await session.read({ query: 'nodeLocks' }, idsShape))
}

/** The ids of the edges the document locks. */
export async function edgeLocksOf(session: DocumentSession): Promise<ReadonlySet<string>> {
  return new Set(await session.read({ query: 'edgeLocks' }, idsShape))
}

/** The document's content as a markdown body or a canvas; `kind` is the index row's, for a document that recorded none. */
export const documentContentOf = (session: DocumentSession, kind: DocumentKind | undefined) =>
  session.read(
    { query: 'documentContent', args: kind === undefined ? {} : { kind } },
    documentContentShape,
  )

const countsShape = z.record(z.string(), z.number())

/** What each thread stores, readable or not, by thread id. */
export const threadMessageCountsOf = (session: DocumentSession) =>
  session.read({ query: 'threadMessageCounts' }, countsShape)
