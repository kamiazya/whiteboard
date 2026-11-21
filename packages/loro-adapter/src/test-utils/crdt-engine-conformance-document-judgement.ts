/**
 * The conformance cases for `documentJudgement`: what judging a document asks
 * of its state, answered from one projection. It is a derived read, so each
 * field must equal the separate read of the same name on the same document,
 * at the head and at the point a view is at, with and without a breach, and a
 * document the record does not host is refused like the reads it combines.
 */
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import type { CrdtEngine } from '../engine/types.js'
import { ask, FIRST, SECOND, splice, write } from './crdt-engine-conformance-kit.js'

const SEPARATE = ['stateSize', 'contentDigest', 'textLimitBreach', 'spatialNodeCount'] as const

function record(engine: CrdtEngine) {
  const { handle } = engine.open({ peer: '5' })
  write(engine, handle, 'createWorkspaceDocumentAtPath', {
    path: 'board',
    documentId: FIRST,
    kind: 'spatial',
  })
  write(engine, handle, 'createWorkspaceDocumentAtPath', {
    path: 'note',
    documentId: SECOND,
    kind: 'markdown',
  })
  write(engine, handle, 'writeSpatialNode', {
    documentId: FIRST,
    node: {
      id: 'n1',
      x: 1,
      y: 2,
      width: 100,
      height: 40,
      resource: { mimeType: 'text/markdown', content: 'box' },
    },
  })
  splice(engine, handle, 0, 0, 'a note', SECOND)
  return handle
}

/** The combined answer beside each separate read of the same document at the same handle. */
async function bothWays(engine: CrdtEngine, handle: number, documentId: string) {
  const combined = (await ask(engine, handle, 'documentJudgement', { documentId })) as {
    ok: Record<string, unknown>
  }
  const separate: Record<string, unknown> = {}
  for (const query of SEPARATE) {
    separate[query] = ((await ask(engine, handle, query, { documentId })) as { ok: unknown }).ok
  }
  const stated = (await ask(engine, handle, 'documentKind', { documentId })) as { ok: unknown }
  // An envelope stating no kind is the engine's marked `undefined` there and `null` here.
  separate.statedKind = typeof stated.ok === 'string' ? stated.ok : null
  return { combined: combined.ok, separate }
}

function describeEquality(makeEngine: () => CrdtEngine) {
  it('equals the separate reads of the same document, for each document of the record', async () => {
    const engine = makeEngine()
    const handle = record(engine)
    for (const documentId of [FIRST, SECOND]) {
      const { combined, separate } = await bothWays(engine, handle, documentId)
      expect(combined, documentId).toEqual(separate)
    }
    const board = await bothWays(engine, handle, FIRST)
    expect(board.combined).toMatchObject({ spatialNodeCount: 1 })
  })

  it('names the kind the document states, and none for one that states nothing', async () => {
    const engine = makeEngine()
    const handle = record(engine)
    write(engine, handle, 'writeDocumentKind', { documentId: FIRST, kind: 'markdown' })
    const stated = await bothWays(engine, handle, FIRST)
    expect(stated.combined).toEqual(stated.separate)
    expect(stated.combined.statedKind).toBe('markdown')
    expect((await bothWays(engine, handle, SECOND)).combined.statedKind).toBeNull()
  })

  it('equals the separate reads for a document that breaks a text limit, and names the breach', async () => {
    const engine = makeEngine()
    const handle = record(engine)
    write(
      engine,
      handle,
      'writeMarkdownBody',
      { documentId: SECOND, body: 'x'.repeat(MARKDOWN_MAX_CHARS + 1) },
      'none',
    )
    const { combined, separate } = await bothWays(engine, handle, SECOND)
    expect(combined).toEqual(separate)
    expect(combined.textLimitBreach).toMatchObject({ shape: 'body' })
  })

  it('equals the separate reads at the point a view is at, and differs from the head', async () => {
    const engine = makeEngine()
    const handle = record(engine)
    const past = engine.version({ handle }).frontiers
    const before = await bothWays(engine, handle, SECOND)
    splice(engine, handle, 0, 0, 'edited: ', SECOND)
    const view = engine.fork({ handle, peer: '7', at: past }).handle
    const atPast = await bothWays(engine, view, SECOND)
    expect(atPast.combined).toEqual(atPast.separate)
    expect(atPast.combined).toEqual(before.combined)
    expect((await bothWays(engine, handle, SECOND)).combined).not.toEqual(before.combined)
  })
}

function describeRefusal(makeEngine: () => CrdtEngine) {
  it('refuses a document the record does not host', async () => {
    const engine = makeEngine()
    const handle = record(engine)
    expect(
      await ask(engine, handle, 'documentJudgement', {
        documentId: '01J0000000000000000000000Z',
      }),
    ).toHaveProperty('err')
  })
}

function describeStandalone(makeEngine: () => CrdtEngine) {
  it('judges the document a handle itself holds when no document is named, as the separate reads do', async () => {
    const engine = makeEngine()
    const record_ = record(engine)
    const { bytes } = engine.export({ handle: record_, mode: 'projection', documentId: SECOND })
    const alone = engine.open({ peer: '9', bytes: bytes as string }).handle
    const combined = (
      (await ask(engine, alone, 'documentJudgement')) as { ok: Record<string, unknown> }
    ).ok
    const separate: Record<string, unknown> = {}
    for (const query of SEPARATE) {
      separate[query] = ((await ask(engine, alone, query)) as { ok: unknown }).ok
    }
    const stated = (await ask(engine, alone, 'documentKind')) as { ok: unknown }
    separate.statedKind = typeof stated.ok === 'string' ? stated.ok : null
    expect(combined).toEqual(separate)
    // The same document asked for by id on the record that hosts it.
    const hosted = (
      (await ask(engine, record_, 'documentJudgement', { documentId: SECOND })) as {
        ok: Record<string, unknown>
      }
    ).ok
    expect(combined).toEqual(hosted)
  })

  it('judges a standalone document that breaks a text limit', async () => {
    const engine = makeEngine()
    const record_ = record(engine)
    write(
      engine,
      record_,
      'writeMarkdownBody',
      { documentId: SECOND, body: 'x'.repeat(MARKDOWN_MAX_CHARS + 1) },
      'none',
    )
    const { bytes } = engine.export({ handle: record_, mode: 'projection', documentId: SECOND })
    const alone = engine.open({ peer: '9', bytes: bytes as string }).handle
    expect(await ask(engine, alone, 'documentJudgement')).toMatchObject({
      ok: { textLimitBreach: { shape: 'body' } },
    })
  })
}

export function describeDocumentJudgement(makeEngine: () => CrdtEngine) {
  describe('documentJudgement', () => {
    describeEquality(makeEngine)
    describeRefusal(makeEngine)
    describeStandalone(makeEngine)
  })
}
