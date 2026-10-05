import { DOCUMENT_NAME_MAX_LENGTH, documentNameSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { apiErrorReason } from '../api-errors.js'
import { createServer } from '../create-server.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreateInputSchema } from './document-crud.schemas.js'
import { workspaceEditInputSchema } from './workspace-edit.js'

const WS = 'ws-names'
const DOC = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const overLimit = 'x'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1)
const atLimit = 'x'.repeat(DOCUMENT_NAME_MAX_LENGTH)

const workspaceOp = (op: Record<string, unknown>) =>
  workspaceEditInputSchema.safeParse({ workspaceId: WS, ops: [op] })

/** Every tool and /api/v1 field a document's display name is written through. */
const WRITERS: ReadonlyArray<readonly [string, (name: string) => unknown]> = [
  [
    'POST /api/v1 documents',
    (name) =>
      wbDocumentCreateInputSchema.safeParse({ workspaceId: WS, path: 'n', kind: 'spatial', name }),
  ],
  [
    'wb_workspace_edit document.create (markdown)',
    (name) => workspaceOp({ op: 'document.create', path: 'n', kind: 'markdown', name }),
  ],
  [
    'wb_workspace_edit document.create (spatial)',
    (name) => workspaceOp({ op: 'document.create', path: 'n', kind: 'spatial', name }),
  ],
  [
    'wb_workspace_edit document.move',
    (name) => workspaceOp({ op: 'document.move', documentId: DOC, name }),
  ],
]

function refusalMessages(parsed: unknown): string[] {
  const result = parsed as { success: boolean; error?: { issues: { message: string }[] } }
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? [])
}

describe('the length of a document name is declared once', () => {
  it.each(WRITERS)('%s refuses one character past the limit, in the same words', (_w, parse) => {
    const expected = refusalMessages(documentNameSchema.safeParse(overLimit))
    expect(expected).toHaveLength(1)
    expect(refusalMessages(parse(overLimit))).toEqual(expected)
  })

  it.each(WRITERS)('%s accepts a name of exactly the limit', (_w, parse) => {
    expect((parse(atLimit) as { success: boolean }).success).toBe(true)
  })

  it('answers 400 to an over-long name on POST /api/v1 documents, minting nothing', async () => {
    const deps = makeTestDeps({ documentTeardown: inMemoryDocumentTeardown() })
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    const { app } = createServer(deps)
    const res = await app.request(`/api/v1/workspaces/${WS}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'n', kind: 'spatial', name: overLimit }),
    })
    expect(res.status).toBe(400)
    expect(apiErrorReason(await res.json())).toMatch(/at most 200 characters/)
    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toEqual([])
  })
})
