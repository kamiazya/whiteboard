import { SYNC_TEXT_BREACH_CODES, type SyncTextBreach } from '@kamiazya/whiteboard-loro-adapter'
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
  DocumentNameTooLongError,
  OffGrammarPathError,
  type SyncWriteRefusalError,
  syncWriteAnswer,
  textBreachRefusal,
  UnreadableDocumentMetaError,
} from './sync-write-refusals.js'

const MAP = 'cid:0@1:Map'

/** One instance of each refusal class the module exports, keyed by class name. */
const SAMPLES: Readonly<Record<string, () => SyncWriteRefusalError>> = {
  OffGrammarPathError: () => new OffGrammarPathError(['Meeting notes']),
  UnreadableDocumentMetaError: () => new UnreadableDocumentMetaError(['0@1']),
  DocumentNameTooLongError: () => new DocumentNameTooLongError(['notes']),
}

/**
 * One text refusal per breach shape, built the one way any is. Keyed by the
 * table both keepers answer from, so a shape added there without a sample
 * here fails to compile.
 */
const TEXT_SAMPLES: Readonly<Record<SyncTextBreach['shape'], () => SyncWriteRefusalError>> = {
  run: () => textBreachRefusal({ shape: 'run', chars: 300_000, container: MAP }),
  body: () => textBreachRefusal({ shape: 'body', chars: 300_000, container: MAP }),
  'node-text': () =>
    textBreachRefusal({ shape: 'node-text', chars: 9_000, nodeId: 'n1', container: MAP }),
  'node-location': () =>
    textBreachRefusal({ shape: 'node-location', chars: 9_000, nodeId: 'n1', container: MAP }),
  label: () => textBreachRefusal({ shape: 'label', chars: 2_000, elementId: 'e1', container: MAP }),
  'comment-message': () =>
    textBreachRefusal({ shape: 'comment-message', chars: 5_000, messageId: 'm1', container: MAP }),
}

const ALL_SAMPLES = [...Object.values(SAMPLES), ...Object.values(TEXT_SAMPLES)]

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
    expect(declared.length).toBeGreaterThanOrEqual(3)
  })

  it('has a sample for every refusal class the module declares', () => {
    // A refusal class added without one fails here, before a route answers it 500.
    expect([...declared].sort()).toEqual(Object.keys(SAMPLES).sort())
  })

  it('answers each refusal with its own code and a client-error status', () => {
    const codeOf = new Map<string, unknown>()
    for (const sample of ALL_SAMPLES) {
      const refusal = sample()
      const answer = syncWriteAnswer(refusal)
      expect(answer?.status).toBeGreaterThanOrEqual(400)
      expect(answer?.status).toBeLessThan(500)
      codeOf.set(refusal.name, answer?.code)
    }
    // One code per class: a run and a body are one class, a body too large.
    expect(new Set(codeOf.values()).size).toBe(codeOf.size)
  })

  it('answers each text breach with the code the shared table gives it', () => {
    for (const [shape, sample] of Object.entries(TEXT_SAMPLES)) {
      expect(syncWriteAnswer(sample())).toEqual({
        code: SYNC_TEXT_BREACH_CODES[shape as SyncTextBreach['shape']],
        status: 413,
      })
    }
  })

  it('answers with exactly the codes the shared vocabulary declares', () => {
    // The client parses a refusal by that vocabulary: a code it does not list
    // reaches the person as "the keeper did not say why", and one listed but
    // never answered is copy nobody reads.
    const codes = new Set(ALL_SAMPLES.map((sample) => syncWriteAnswer(sample())?.code))
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
      TEXT_SAMPLES['node-text'],
      NODE_TEXT_LIMIT_PHRASE,
      nodeTextInputSchema,
      NODE_TEXT_MAX_CHARS,
    ],
    [
      'a location',
      TEXT_SAMPLES['node-location'],
      NODE_LOCATION_LIMIT_PHRASE,
      nodeFileInputSchema,
      NODE_LOCATION_MAX_CHARS,
    ],
    ['a label', TEXT_SAMPLES.label, LABEL_LIMIT_PHRASE, labelInputSchema, LABEL_MAX_CHARS],
    [
      'a comment message',
      TEXT_SAMPLES['comment-message'],
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
