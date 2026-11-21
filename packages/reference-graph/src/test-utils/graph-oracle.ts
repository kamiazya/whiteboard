/**
 * What the recorder (`scripts/record-graph-oracle.ts`) and the replay
 * (`oracle/graph-rules-recorded-oracle.test.ts`) both use to run one recorded
 * row. A refusal is recorded as its class, plus the breach a rewrite refusal
 * carries, because the Rust replay has to refuse the same inputs and a message
 * is the one thing a port words differently.
 */
import type { ContentWithTags, DocumentContent } from '@kamiazya/whiteboard-loro-adapter'
import type { DocumentEntry } from '@kamiazya/whiteboard-ports'
import { extractContentFacts, splitBearerTags, tagBearersOf } from '../extract.js'
import { planLinkifyMentions } from '../linkify.js'
import { backlinksIn, type RawReference, unlinkedNameSpans } from '../reference-aggregate.js'
import { planDocumentReferenceRewrite } from '../rewrite.js'
import { ReferenceRewriteTooLargeError } from '../text-limit.js'

export type Answer = { ok: unknown } | { err: string; breach?: Breach }

type Breach = ReferenceRewriteTooLargeError['breach']
type Target = { documentId: string; path: string; name: string }
type ContentFactsRow = { refs: RawReference[]; texts: string[] }

export interface GraphRow {
  op: string
  loaded?: ContentWithTags
  bearers?: Array<{ what: string; tags: string[] }>
  content?: DocumentContent
  target?: Target
  plan?: Array<[string, string]>
  text?: string
  name?: string
  entries?: DocumentEntry[]
  facts?: Array<[string, ContentFactsRow]>
  documentId?: string
  breach?: Breach
}

const plain = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value))

export function replay(row: GraphRow): Answer {
  try {
    return { ok: plain(run(row)) }
  } catch (error) {
    if (error instanceof ReferenceRewriteTooLargeError) {
      return { err: error.constructor.name, breach: error.breach }
    }
    return { err: error instanceof Error ? error.constructor.name : typeof error }
  }
}

function run(row: GraphRow): unknown {
  switch (row.op) {
    case 'extractContentFacts':
      return extractContentFacts(row.loaded as ContentWithTags)
    case 'tagBearersOf':
      return tagBearersOf(row.loaded as ContentWithTags)
    case 'splitBearerTags':
      return splitBearerTags(row.bearers ?? [])
    case 'planLinkifyMentions':
      return planLinkifyMentions(row.content as DocumentContent, row.target as Target)
    case 'planDocumentReferenceRewrite':
      return planDocumentReferenceRewrite(row.content as DocumentContent, new Map(row.plan ?? []))
    case 'unlinkedNameSpans':
      return unlinkedNameSpans(row.text as string, row.name as string)
    case 'backlinksIn':
      return backlinksIn(row.entries ?? [], new Map(row.facts ?? []), row.documentId as string)
    case 'breachMessage': {
      const error = new ReferenceRewriteTooLargeError(row.breach as Breach)
      return { name: error.name, message: error.message }
    }
    default:
      throw new Error(`no replay for ${row.op}`)
  }
}
