import { describe, expect, it } from 'vitest'
import { DocumentEngineTrapError } from '../document-io.js'
import * as refusals from './sync-write-refusals.js'
import {
  DocumentNameTooLongError,
  MarkdownBodyTooLargeError,
  NodeTextTooLargeError,
  OffGrammarPathError,
  type SyncWriteRefusalError,
  syncWriteAnswer,
  UnreadableDocumentMetaError,
} from './sync-write-refusals.js'

/** One instance of each refusal the module declares, keyed by class name. */
const SAMPLES: Readonly<Record<string, () => SyncWriteRefusalError>> = {
  MarkdownBodyTooLargeError: () => new MarkdownBodyTooLargeError('run', 300_000),
  NodeTextTooLargeError: () => new NodeTextTooLargeError('n1', 9_000),
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
      value !== refusals.SyncWriteRefusalError,
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

  it('answers an engine trap as the server fault /api/v1 names it', () => {
    expect(
      syncWriteAnswer(new DocumentEngineTrapError('document d', 'importing an update into', null)),
    ).toEqual({ code: 'document_engine_trap', status: 500 })
  })

  it('answers nothing else', () => {
    expect(syncWriteAnswer(new Error('anything'))).toBeUndefined()
  })
})
