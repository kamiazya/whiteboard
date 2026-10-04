import { MARKDOWN_MAX_CHARS, markdownInputSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { apiErrorReason } from '../api-errors.js'
import { createServer } from '../create-server.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreate } from './document-crud.js'
import { wbDocumentCreateInputSchema } from './document-crud.schemas.js'
import { documentSetInputSchema } from './document-set.js'
import { createWorkspaceEditTool, workspaceEditInputSchema } from './workspace-edit.js'

const WS = 'ws-limit'
const DOC = '01H8XJZ9K5N4M3P2Q1R0S9T8V8'
const overLimit = 'x'.repeat(MARKDOWN_MAX_CHARS + 1)
const atLimit = 'x'.repeat(MARKDOWN_MAX_CHARS)
const REFUSAL = /character limit for one write/

/** Every way a caller hands a whole markdown document to the write path. */
const WRITERS: ReadonlyArray<readonly [string, (markdown: string) => unknown]> = [
  [
    'wb_document_create (and POST /api/v1 documents)',
    (markdown) =>
      wbDocumentCreateInputSchema.safeParse({
        workspaceId: WS,
        path: 'big',
        kind: 'markdown',
        markdown,
      }),
  ],
  [
    'wb_document_set',
    (markdown) => documentSetInputSchema.safeParse({ workspaceId: WS, documentId: DOC, markdown }),
  ],
  [
    'wb_workspace_edit document.create',
    (markdown) =>
      workspaceEditInputSchema.safeParse({
        workspaceId: WS,
        ops: [{ op: 'document.create', path: 'big', kind: 'markdown', markdown }],
      }),
  ],
  [
    'wb_workspace_edit document.set',
    (markdown) =>
      workspaceEditInputSchema.safeParse({
        workspaceId: WS,
        ops: [{ op: 'document.set', documentId: DOC, markdown }],
      }),
  ],
]

function refusalMessages(parsed: unknown): string[] {
  const result = parsed as { success: boolean; error?: { issues: { message: string }[] } }
  return result.success ? [] : (result.error?.issues.map((issue) => issue.message) ?? [])
}

describe('the size of one markdown write is declared once', () => {
  it('names the limit the shared schema declares', () => {
    const refusal = markdownInputSchema.safeParse(overLimit)
    expect(refusal.success).toBe(false)
    expect(refusalMessages(refusal)[0]).toMatch(REFUSAL)
    expect(refusalMessages(refusal)[0]).toContain(String(MARKDOWN_MAX_CHARS))
  })

  it.each(WRITERS)('%s refuses one character past the limit, in the same words', (_name, parse) => {
    expect(refusalMessages(parse(overLimit))).toEqual(
      refusalMessages(markdownInputSchema.safeParse(overLimit)),
    )
  })

  it.each(WRITERS)('%s accepts a body of exactly the limit', (_name, parse) => {
    expect((parse(atLimit) as { success: boolean }).success).toBe(true)
  })
})

describe('an oversized write is refused before anything exists', () => {
  it('wb_document_create leaves no document behind', async () => {
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'big',
        kind: 'markdown',
        markdown: overLimit,
      }),
    ).rejects.toThrow(REFUSAL)
    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toEqual([])
  })

  it('wb_workspace_edit refuses the batch without applying any op', async () => {
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    await expect(
      createWorkspaceEditTool(deps).execute({
        workspaceId: WS,
        ops: [
          { op: 'document.create', path: 'fine', kind: 'markdown', markdown: 'small' },
          { op: 'document.create', path: 'big', kind: 'markdown', markdown: overLimit },
        ],
      }),
    ).rejects.toThrow(REFUSAL)
    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toEqual([])
  })

  it('POST /api/v1 documents answers 400 with the same reason', async () => {
    const deps = makeTestDeps({ documentTeardown: inMemoryDocumentTeardown() })
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    const { app } = createServer(deps)
    const res = await app.request(`/api/v1/workspaces/${WS}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'big', kind: 'markdown', markdown: overLimit }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ error: 'invalid_request' })
    expect(apiErrorReason(body)).toMatch(REFUSAL)
    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toEqual([])
  })
})
