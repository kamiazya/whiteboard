import {
  readMarkdownBody,
  readProposals,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import { MARKDOWN_MAX_CHARS } from '@kamiazya/whiteboard-model'
import { chunkSnapshot, reassembleSnapshot } from '@kamiazya/whiteboard-ports'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createBodyEditTool } from './body-edit.js'
import { PassageNotApplicableError } from './errors.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const docRef = { kind: 'document' as const, workspaceId: WORKSPACE_ID, documentId: DOCUMENT_ID }

async function seedMarkdown(store: FakeDocumentStore, body: string): Promise<void> {
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const doc = new LoroDoc()
  writeDocumentKind(doc, 'markdown')
  writeMarkdownBody(doc, body)
  const { manifest, chunks } = chunkSnapshot(doc.export({ mode: 'snapshot' }), 1_000_000)
  await store.saveSnapshot({
    docRef,
    manifest,
    chunks,
    frontier: doc.oplogVersion().encode() as Uint8Array<ArrayBuffer>,
  })
}

async function storedDoc(store: FakeDocumentStore): Promise<LoroDoc> {
  const saved = await store.loadSnapshot({ docRef })
  if (saved === null) throw new Error('nothing saved')
  const doc = new LoroDoc()
  doc.import(reassembleSnapshot(saved.manifest, saved.chunks))
  return doc
}

function makeDeps(store: FakeDocumentStore) {
  return makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
}

function passage(body: string, exact: string) {
  const start = body.indexOf(exact)
  return { kind: 'text' as const, quote: { exact }, start, end: start + exact.length }
}

describe('the size of the body a passage edit may leave', () => {
  // Same ceiling `markdownInputSchema` puts on a whole-document write: a
  // replacement passage reaches the CRDT by the same text insert, so a body
  // grown past it by editing costs what a body written past it would.
  const LIMIT_REFUSAL = /character limit for one write/

  async function seedFilled(store: FakeDocumentStore, length: number): Promise<string> {
    const body = `tail-${'x'.repeat(length - 'tail-'.length)}`
    await seedMarkdown(store, body)
    return body
  }

  function replaceTail(body: string, text: string, mode: 'apply' | 'propose') {
    return {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      mode,
      ops: [
        {
          id: 'c1',
          op: 'body.replace' as const,
          anchor: passage(body, 'tail'),
          text,
          assumed: 'tail',
        },
      ],
    }
  }

  test('refuses a replacement that grows the body past the limit and writes nothing', async () => {
    const store = new FakeDocumentStore()
    const body = await seedFilled(store, MARKDOWN_MAX_CHARS)

    const refused = createBodyEditTool(makeDeps(store)).execute(replaceTail(body, 'tails', 'apply'))
    await expect(refused).rejects.toBeInstanceOf(PassageNotApplicableError)
    await expect(refused).rejects.toThrow(LIMIT_REFUSAL)
    expect(readMarkdownBody(await storedDoc(store))).toBe(body)
  })

  test('refuses a proposal whose adoption would grow the body past the limit', async () => {
    const store = new FakeDocumentStore()
    const body = await seedFilled(store, MARKDOWN_MAX_CHARS)

    await expect(
      createBodyEditTool(makeDeps(store)).execute(replaceTail(body, 'tails', 'propose')),
    ).rejects.toThrow(LIMIT_REFUSAL)
    expect(readProposals(await storedDoc(store))).toEqual([])
  })

  test('accepts a replacement that lands exactly on the limit', async () => {
    const store = new FakeDocumentStore()
    const body = await seedFilled(store, MARKDOWN_MAX_CHARS - 1)

    const result = await createBodyEditTool(makeDeps(store)).execute(
      replaceTail(body, 'tails', 'apply'),
    )
    expect(result.body).toHaveLength(MARKDOWN_MAX_CHARS)
    expect(result.applied).toBe(1)
  })

  test('lets an edit shrink a body that is already past the limit', async () => {
    // A document written before the limit existed must stay editable toward
    // the limit, so only an edit that GROWS it is refused.
    const store = new FakeDocumentStore()
    const body = await seedFilled(store, MARKDOWN_MAX_CHARS + 100)

    const result = await createBodyEditTool(makeDeps(store)).execute(
      replaceTail(body, 't', 'apply'),
    )
    expect(result.body).toHaveLength(MARKDOWN_MAX_CHARS + 97)
  })

  test('lets an edit that keeps an over-limit body the same length through', async () => {
    const store = new FakeDocumentStore()
    const body = await seedFilled(store, MARKDOWN_MAX_CHARS + 100)

    const result = await createBodyEditTool(makeDeps(store)).execute(
      replaceTail(body, 'TAIL', 'apply'),
    )
    expect(result.body).toHaveLength(MARKDOWN_MAX_CHARS + 100)
    expect(result.body.startsWith('TAIL-')).toBe(true)
  })

  // The refusal names one change, and the one to shrink is the one that grows
  // the body most: a long replacement of a long passage may grow it least.
  test('names the change that grows the body most when a batch is refused', async () => {
    const store = new FakeDocumentStore()
    const body = `aaaa-b-${'x'.repeat(MARKDOWN_MAX_CHARS - 'aaaa-b-'.length)}`
    await seedMarkdown(store, body)
    const op = (id: string, exact: string, text: string) => ({
      id,
      op: 'body.replace' as const,
      anchor: passage(body, exact),
      text,
      assumed: exact,
    })

    const refused = await createBodyEditTool(makeDeps(store))
      .execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        mode: 'apply',
        ops: [op('longer-text', 'aaaa', 'zzzzzz'), op('more-growth', 'b', 'yyyyy')],
      })
      .catch((err: unknown) => err)

    expect(refused).toBeInstanceOf(PassageNotApplicableError)
    expect((refused as PassageNotApplicableError).changeId).toBe('more-growth')
  })
})
