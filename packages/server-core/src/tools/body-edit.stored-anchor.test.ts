import {
  readProposals,
  writeDocumentKind,
  writeMarkdownBody,
} from '@kamiazya/whiteboard-loro-adapter'
import type { TextAnchor } from '@kamiazya/whiteboard-model'
import { describe, expect, test } from 'vitest'
import { loadDocument } from '../document-io.js'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createBodyEditTool } from './body-edit.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'

/**
 * Proposes one passage over `body` and answers the anchor the proposal
 * stored, checked against what the call answered so the two cannot differ.
 */
async function anchorStored(body: string, anchor: TextAnchor): Promise<unknown> {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, body)
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  const deps = makeTestDeps({ documentStore: store, documentIndex: store.documentIndex })
  const exact = anchor.quote.exact
  const result = await createBodyEditTool(deps).execute({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    mode: 'propose',
    ops: [{ id: 'c1', op: 'body.replace', anchor, text: exact.toUpperCase(), assumed: exact }],
  })
  const { doc } = await loadDocument(deps, WORKSPACE_ID, DOCUMENT_ID)
  const stored = readProposals(doc)[0]?.changes[0]
  expect(result.proposed?.changes[0]).toEqual(stored)
  return stored?.op === 'body.replace' ? stored.anchor : undefined
}

// The quote is what finds a passage, and the stored offsets are only the
// shortcut every later reader (the editor's in-place projection, an Adopt, a
// continuing call's overlap check) tries first. Offsets that contradict the
// quote send each of those readers through a whole-body search every time,
// so the write stores where the quote resolved, as `wb_thread_edit` does.
describe('wb_body_edit stores a proposed passage at where its quote is', () => {
  test('moves miscounted offsets onto the quote', async () => {
    expect(
      await anchorStored('hello world, hello again', {
        kind: 'text',
        quote: { exact: 'world' },
        start: 2,
        end: 7,
      }),
    ).toEqual({ kind: 'text', quote: { exact: 'world' }, start: 6, end: 11 })
  })

  test('keeps offsets that already select the quote, even when it occurs twice', async () => {
    const anchor: TextAnchor = { kind: 'text', quote: { exact: 'echo' }, start: 10, end: 14 }
    expect(await anchorStored('echo one, echo two', anchor)).toEqual(anchor)
  })
})
