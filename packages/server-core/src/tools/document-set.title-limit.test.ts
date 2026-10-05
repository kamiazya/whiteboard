import { DOCUMENT_NAME_MAX_LENGTH } from '@kamiazya/whiteboard-model'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { apiErrorReason } from '../api-errors.js'
import { createServer } from '../create-server.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { OkfParseError, parseWritableOkf } from './document-set.js'
import { createWorkspaceEditTool } from './workspace-edit.js'

const WS = 'titles'
const okf = (title: string) => `---\ntype: note\ntitle: ${title}\n---\nbody`
const overLimit = 'T'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1)
const atLimit = 'T'.repeat(DOCUMENT_NAME_MAX_LENGTH)
// The parse's own sentence, not merely the bound's words: the index refuses
// an over-long name too, but only after `document.create` has minted.
const REFUSAL = /frontmatter-title.*at most 200 characters/s

async function makeDeps() {
  const deps = makeTestDeps({
    documentStore: new InMemoryDocumentStore(),
    documentTeardown: inMemoryDocumentTeardown(),
  })
  await deps.documentIndex.createWorkspace({ workspaceId: WS })
  return deps
}

/**
 * A frontmatter `title` becomes the document's display name, so it is held to
 * the same bound as a `name` sent directly — refused while the caller still
 * holds the content, before anything is minted.
 */
describe('a frontmatter title past the document name bound', () => {
  it('is refused by the writable parse, naming its stage and the bound', () => {
    const attempt = () => parseWritableOkf(okf(overLimit))
    expect(attempt).toThrow(OkfParseError)
    expect(attempt).toThrow(REFUSAL)
  })

  it('is taken at exactly the bound', () => {
    expect(parseWritableOkf(okf(atLimit)).frontmatter.title).toBe(atLimit)
  })

  it('is refused by document.create before the document exists', async () => {
    const deps = await makeDeps()
    await expect(
      createWorkspaceEditTool(deps).execute({
        workspaceId: WS,
        ops: [{ op: 'document.create', path: 'long', kind: 'markdown', markdown: okf(overLimit) }],
      }),
    ).rejects.toThrow(REFUSAL)
    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toEqual([])
  })

  it('is refused by document.set, and the name stays as it was', async () => {
    const deps = await makeDeps()
    const tool = createWorkspaceEditTool(deps)
    const created = await tool.execute({
      workspaceId: WS,
      ops: [{ op: 'document.create', path: 'kept', kind: 'markdown', markdown: okf('Kept') }],
    })
    const documentId = created.results[0]?.documentId ?? ''
    await expect(
      tool.execute({
        workspaceId: WS,
        ops: [{ op: 'document.set', documentId, markdown: okf(overLimit) }],
      }),
    ).rejects.toThrow(REFUSAL)
    const listed = await deps.documentIndex.listDocuments({ workspaceId: WS })
    expect(listed.map((entry) => [entry.path, entry.name])).toEqual([['kept', 'Kept']])
  })

  it('is refused by POST /api/v1 documents as a parse refusal, minting nothing', async () => {
    const deps = await makeDeps()
    const { app } = createServer(deps)
    const res = await app.request(`/api/v1/workspaces/${WS}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'long', kind: 'markdown', markdown: okf(overLimit) }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ error: 'okf_parse_failed' })
    expect(apiErrorReason(body)).toMatch(REFUSAL)
    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toEqual([])
  })
})
