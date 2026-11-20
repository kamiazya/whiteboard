/**
 * The conformance cases for the readers that judge a whole document (its size,
 * its content digest, its text limits) when `documentId` names one document of
 * a workspace record: each answers for that document as a document of its own,
 * not for the record that hosts it, and the same at a past point of a view.
 */
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { CrdtEngine } from '../engine/types.js'
import { ask, FIRST, openWith, SECOND, splice, write } from './crdt-engine-conformance-kit.js'

const READERS = ['stateSize', 'contentDigest', 'textLimitBreach'] as const

/** A record of two markdown documents, so an answer for the record cannot pass for either. */
function twoNotes(engine: CrdtEngine) {
  const { handle } = engine.open({ peer: '5' })
  for (const [documentId, path] of [
    [FIRST, 'one'],
    [SECOND, 'two'],
  ] as const) {
    write(engine, handle, 'createWorkspaceDocumentAtPath', { path, documentId, kind: 'markdown' })
  }
  splice(engine, handle, 0, 0, 'a short note', FIRST)
  splice(engine, handle, 0, 0, 'a second note, longer than the first', SECOND)
  return handle
}

/** The document as a standalone one an engine opened from its projection: what the answer must equal. */
function standalone(engine: CrdtEngine, record: number, documentId: string): number {
  const { bytes } = engine.export({ handle: record, mode: 'projection', documentId })
  return engine.open({ peer: '9', bytes: bytes as string }).handle
}

function describeDocumentReadersPart1(makeEngine: () => CrdtEngine) {
  it.each(
    READERS,
  )('%s answers for the document, as for its projection opened alone', async (query) => {
    const engine = makeEngine()
    const record = twoNotes(engine)
    for (const documentId of [FIRST, SECOND]) {
      const alone = await ask(engine, standalone(engine, record, documentId), query)
      expect(await ask(engine, record, query, { documentId }), documentId).toEqual(alone)
    }
  })

  it.each([
    'stateSize',
    'contentDigest',
  ] as const)('%s tells two documents of one record apart, and neither from the record', async (query) => {
    const engine = makeEngine()
    const record = twoNotes(engine)
    const answers = [
      await ask(engine, record, query, { documentId: FIRST }),
      await ask(engine, record, query, { documentId: SECOND }),
      await ask(engine, record, query),
    ].map((answer) => JSON.stringify(answer))
    expect(new Set(answers).size).toBe(3)
  })
}

function describeDocumentReadersPart2(makeEngine: () => CrdtEngine) {
  it('judges the text limits of the one document that breaks them, not the record that hosts it', async () => {
    const engine = makeEngine()
    const record = twoNotes(engine)
    write(
      engine,
      record,
      'writeMarkdownBody',
      { documentId: SECOND, body: 'x'.repeat(MARKDOWN_MAX_CHARS + 1) },
      'none',
    )
    expect(await ask(engine, record, 'textLimitBreach', { documentId: FIRST })).toEqual({
      ok: null,
    })
    expect(await ask(engine, record, 'textLimitBreach', { documentId: SECOND })).toMatchObject({
      ok: { shape: 'body', chars: MARKDOWN_MAX_CHARS + 1 },
    })
    expect(await ask(engine, record, 'textLimitBreach')).toMatchObject({
      ok: { shape: 'body' },
    })
  })

  it.each([
    'stateSize',
    'contentDigest',
  ] as const)('%s answers for the document as it stood at the point a view is at', async (query) => {
    const engine = makeEngine()
    const record = twoNotes(engine)
    const past = engine.version({ handle: record }).frontiers
    const before = await ask(engine, record, query, { documentId: FIRST })
    splice(engine, record, 0, 0, 'edited: ', FIRST)
    const view = engine.fork({ handle: record, peer: '7', at: past }).handle
    const atPast = await ask(engine, view, query, { documentId: FIRST })
    expect(atPast).toEqual(before)
    expect(await ask(engine, record, query, { documentId: FIRST })).not.toEqual(before)
    expect(await ask(engine, view, query)).not.toEqual(atPast)
  })
}

function describeDocumentReadersPart3(makeEngine: () => CrdtEngine) {
  it('judges the text limits of a document as it stood at the point a view is at', async () => {
    const engine = makeEngine()
    const record = twoNotes(engine)
    write(
      engine,
      record,
      'writeMarkdownBody',
      { documentId: SECOND, body: 'x'.repeat(MARKDOWN_MAX_CHARS + 1) },
      'none',
    )
    const past = engine.version({ handle: record }).frontiers
    write(
      engine,
      record,
      'writeMarkdownBody',
      { documentId: FIRST, body: 'y'.repeat(MARKDOWN_MAX_CHARS + 1) },
      'none',
    )
    const view = engine.fork({ handle: record, peer: '7', at: past }).handle
    expect(await ask(engine, view, 'textLimitBreach', { documentId: FIRST })).toEqual({
      ok: null,
    })
    expect(await ask(engine, view, 'textLimitBreach', { documentId: SECOND })).toMatchObject({
      ok: { shape: 'body' },
    })
    expect(await ask(engine, record, 'textLimitBreach', { documentId: FIRST })).toMatchObject({
      ok: { shape: 'body' },
    })
  })
}

function describeDocumentReadersPart4(makeEngine: () => CrdtEngine) {
  it('refuses a document the record does not host', async () => {
    const engine = makeEngine()
    const record = twoNotes(engine)
    for (const query of READERS) {
      expect(
        await ask(engine, record, query, { documentId: '01J0000000000000000000000Z' }),
        query,
      ).toHaveProperty('err')
    }
  })

  it('keeps answering for the whole document when a handle holds a document of its own', async () => {
    const engine = makeEngine()
    const handle = openWith(engine, 'alone')
    for (const query of READERS) {
      expect(await ask(engine, handle, query), query).toHaveProperty('ok')
    }
  })
}

export function describeDocumentReaders(makeEngine: () => CrdtEngine) {
  describe('the whole-document readers on one document of a workspace record', () => {
    describeDocumentReadersPart1(makeEngine)
    describeDocumentReadersPart2(makeEngine)
    describeDocumentReadersPart3(makeEngine)
    describeDocumentReadersPart4(makeEngine)
  })
}
