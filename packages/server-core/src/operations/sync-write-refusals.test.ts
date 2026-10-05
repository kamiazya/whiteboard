import {
  COMMENT_MESSAGE_LIMIT_PHRASE,
  COMMENT_MESSAGE_MAX_CHARS,
  commentMessageInputSchema,
  LABEL_LIMIT_PHRASE,
  LABEL_MAX_CHARS,
  labelInputSchema,
  NODE_LOCATION_LIMIT_PHRASE,
  NODE_LOCATION_MAX_CHARS,
  NODE_TEXT_LIMIT_PHRASE,
  NODE_TEXT_MAX_CHARS,
  nodeFileInputSchema,
  nodeTextInputSchema,
  syncWriteRefusalCodeSchema,
} from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { ZodString } from 'zod'
import { DocumentEngineTrapError } from '../document-io.js'
import * as refusals from './sync-write-refusals.js'
import {
  CommentMessageTooLargeError,
  DocumentNameTooLongError,
  LabelTooLargeError,
  MarkdownBodyTooLargeError,
  NodeLocationTooLargeError,
  NodeTextTooLargeError,
  OffGrammarPathError,
  type SyncWriteRefusalError,
  syncWriteAnswer,
  UnreadableDocumentMetaError,
} from './sync-write-refusals.js'

const MAP = 'cid:0@1:Map'

/** One instance of each refusal the module declares, keyed by class name. */
const SAMPLES: Readonly<Record<string, () => SyncWriteRefusalError>> = {
  MarkdownBodyTooLargeError: () =>
    new MarkdownBodyTooLargeError({ shape: 'run', chars: 300_000, container: MAP }),
  NodeTextTooLargeError: () =>
    new NodeTextTooLargeError({ shape: 'node-text', chars: 9_000, nodeId: 'n1', container: MAP }),
  NodeLocationTooLargeError: () =>
    new NodeLocationTooLargeError({
      shape: 'node-location',
      chars: 9_000,
      nodeId: 'n1',
      container: MAP,
    }),
  LabelTooLargeError: () =>
    new LabelTooLargeError({ shape: 'label', chars: 2_000, elementId: 'e1', container: MAP }),
  CommentMessageTooLargeError: () =>
    new CommentMessageTooLargeError({
      shape: 'comment-message',
      chars: 5_000,
      messageId: 'm1',
      container: MAP,
    }),
  OffGrammarPathError: () => new OffGrammarPathError(['Meeting notes']),
  UnreadableDocumentMetaError: () => new UnreadableDocumentMetaError(['0@1']),
  DocumentNameTooLongError: () => new DocumentNameTooLongError(['notes']),
}

/** The concrete error classes the module exports, found rather than listed. */
const declared = Object.entries(refusals)
  .filter(
    ([, value]) =>
      typeof value === 'function' &&
      value.prototype instanceof Error &&
      value !== refusals.SyncWriteRefusalError &&
      value !== refusals.TextBreachRefusalError,
  )
  .map(([name]) => name)

describe('syncWriteAnswer', () => {
  it('finds the refusal classes it judges', () => {
    expect(declared.length).toBeGreaterThanOrEqual(5)
  })

  it('has a sample for every refusal class the module declares', () => {
    // A refusal class added without one fails here, before a route answers it 500.
    expect([...declared].sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  it('answers each refusal with its own code and a client-error status', () => {
    const codes = Object.values(SAMPLES).map((sample) => {
      const answer = syncWriteAnswer(sample())
      expect(answer?.status).toBeGreaterThanOrEqual(400)
      expect(answer?.status).toBeLessThan(500)
      return answer?.code
    })
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('answers with exactly the codes the shared vocabulary declares', () => {
    // The client parses a refusal by that vocabulary: a code it does not list
    // reaches the person as "the keeper did not say why", and one listed but
    // never answered is copy nobody reads.
    const codes = new Set(Object.values(SAMPLES).map((sample) => syncWriteAnswer(sample())?.code))
    expect([...codes].sort()).toEqual([...syncWriteRefusalCodeSchema.options].sort())
  })

  it('answers an engine trap as the server fault /api/v1 names it', () => {
    expect(
      syncWriteAnswer(new DocumentEngineTrapError('document d', 'importing an update into', null)),
    ).toEqual({ code: 'document_engine_trap', status: 500 })
  })

  it('answers nothing else', () => {
    expect(syncWriteAnswer(new Error('anything'))).toBeUndefined()
  })
})

describe('a refused text bound', () => {
  // A sync write and a tool write past the same bound tell the writer the
  // same limit and the same way out, whichever path refused it.
  it.each([
    [
      'node text',
      SAMPLES.NodeTextTooLargeError,
      NODE_TEXT_LIMIT_PHRASE,
      nodeTextInputSchema,
      NODE_TEXT_MAX_CHARS,
    ],
    [
      'a location',
      SAMPLES.NodeLocationTooLargeError,
      NODE_LOCATION_LIMIT_PHRASE,
      nodeFileInputSchema,
      NODE_LOCATION_MAX_CHARS,
    ],
    ['a label', SAMPLES.LabelTooLargeError, LABEL_LIMIT_PHRASE, labelInputSchema, LABEL_MAX_CHARS],
    [
      'a comment message',
      SAMPLES.CommentMessageTooLargeError,
      COMMENT_MESSAGE_LIMIT_PHRASE,
      commentMessageInputSchema,
      COMMENT_MESSAGE_MAX_CHARS,
    ],
  ] as const)('ends %s as the tools do', (_, sample, phrase, schema: ZodString, max) => {
    // The whole tail, so a refusal that adds its own qualifier after the bound fails.
    const tail = (text: string | undefined, clause: string) => text?.slice(-clause.length)
    const syncRefusal = sample?.().message
    expect(tail(syncRefusal, `, past ${phrase}`)).toBe(`, past ${phrase}`)
    const toolRefusal = schema.safeParse('x'.repeat(max + 1)).error?.issues[0]?.message
    expect(tail(toolRefusal, ` is longer than ${phrase}`)).toBe(` is longer than ${phrase}`)
  })
})
