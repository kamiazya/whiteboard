import { describe, expect, it } from 'vitest'
import { createServer } from './create-server.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from './test-utils/unused-document-teardown.js'

/** Written out rather than imported, so the test is not judged by the constant it judges. */
const CEILING = 2000
const WS = 'crowded'

describe('POST /api/v1/workspaces/:ws/documents at the document ceiling', () => {
  it('answers 413 too_many_documents, in the code the sync routes use', async () => {
    const deps = makeTestDeps({ documentTeardown: inMemoryDocumentTeardown() })
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    for (let i = 0; i < CEILING; i++) {
      await deps.documentIndex.createDocument({ workspaceId: WS, path: `d${i}`, kind: 'spatial' })
    }

    const res = await createServer(deps).app.request(`/api/v1/workspaces/${WS}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'one-more', kind: 'spatial' }),
    })

    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: string }).error).toBe('too_many_documents')
    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toHaveLength(CEILING)
  })
})
