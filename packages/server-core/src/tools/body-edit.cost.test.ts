/**
 * What `wb_body_edit` pays for the passages a proposal already holds when a
 * call continues it, COUNTED as `indexOf` calls so the number is the same on
 * any machine and under any load.
 *
 * A continuation re-places every open passage of the proposal to check the
 * new ones against them, under the workspace's write lock. The shape is the
 * expensive one: each held passage quotes one character of a periodic body,
 * at offsets that no longer hold it, so every one has to be searched for
 * among thousands of occurrences.
 */
import {
  writeDocumentKind,
  writeMarkdownBody,
  writeProposal,
} from '@kamiazya/whiteboard-loro-adapter'
import type { ProposedChange } from '@kamiazya/whiteboard-model'
import { describe, expect, test } from 'vitest'
import {
  FakeDocumentStore,
  registerDocumentInWorkspace,
  seedDoc,
} from '../test-utils/fake-document-store.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { createBodyEditTool } from './body-edit.js'
import { PassageNotApplicableError } from './errors.js'

const DOCUMENT_ID = '01H8XJZ9K5N4M3P2Q1R0S9T8V7'
const WORKSPACE_ID = 'ws-1'
const BODY = 'ab'.repeat(32 * 1024)
const CONTEXT = 'ab'.repeat(16)
const HELD = 200

/** Open passages on `a`, stored one character off — every offset lands on a `b`. */
function heldPassages(): ProposedChange[] {
  return Array.from({ length: HELD }, (_, i) => {
    const start = 1001 + 64 * i
    return {
      id: `held${i}`,
      status: 'open',
      op: 'body.replace',
      text: 'A',
      assumed: 'a',
      anchor: {
        kind: 'text',
        quote: { exact: 'a', prefix: `x${CONTEXT.slice(1)}`, suffix: `b${CONTEXT.slice(0, -1)}` },
        start,
        end: start + 1,
      },
    }
  })
}

async function continued() {
  const store = new FakeDocumentStore()
  await seedDoc(store, DOCUMENT_ID, (doc) => {
    writeDocumentKind(doc, 'markdown')
    writeMarkdownBody(doc, BODY)
    writeProposal(doc, { id: 'p1', changes: heldPassages() })
  })
  await registerDocumentInWorkspace(store, WORKSPACE_ID, DOCUMENT_ID)
  store.documentIndex.seed({
    workspaceId: WORKSPACE_ID,
    documentId: DOCUMENT_ID,
    path: 'doc',
    kind: 'markdown',
  })
  return createBodyEditTool(
    makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
  )
}

async function countingSearches(run: () => Promise<unknown>): Promise<number> {
  let searches = 0
  const indexOf = String.prototype.indexOf
  String.prototype.indexOf = function (this: string, ...args: [string, number?]) {
    searches += 1
    return indexOf.apply(this, args)
  }
  try {
    await run().catch(() => undefined)
  } finally {
    String.prototype.indexOf = indexOf
  }
  return searches
}

const passage = (exact: string, start: number) =>
  ({
    op: 'body.replace',
    id: 'new',
    anchor: { kind: 'text', quote: { exact }, start, end: start + exact.length },
    text: 'Z',
    assumed: exact,
  }) as const

describe('continuing a proposal', () => {
  test('re-places each held passage at a bounded cost however often its quote occurs', async () => {
    const tool = await continued()
    let result: Awaited<ReturnType<typeof tool.execute>> | undefined
    const searches = await countingSearches(async () => {
      result = await tool.execute({
        workspaceId: WORKSPACE_ID,
        documentId: DOCUMENT_ID,
        proposalId: 'p1',
        ops: [passage('a', 60_000)],
      })
    })
    expect(result?.proposed?.changes).toHaveLength(HELD + 1)
    // About 4,100 a held passage, searching outward a step either side; it
    // was one per occurrence, 32,769, before resolution scored only the
    // nearest occurrences.
    expect(searches / HELD).toBeLessThanOrEqual(5_000)
  })

  test('refuses an op that cannot be placed before re-placing anything held', async () => {
    const tool = await continued()
    let refusal: unknown
    const searches = await countingSearches(() =>
      tool
        .execute({
          workspaceId: WORKSPACE_ID,
          documentId: DOCUMENT_ID,
          proposalId: 'p1',
          ops: [passage('not in the body', 0)],
        })
        .catch((err: unknown) => {
          refusal = err
        }),
    )
    expect(refusal).toBeInstanceOf(PassageNotApplicableError)
    // The refused op's own search, a step at a time across the body.
    expect(searches).toBeLessThan(HELD)
  })
})
