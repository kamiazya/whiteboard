import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { apiErrorReason } from './api-errors.js'
import { createServer } from './create-server.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from './test-utils/unused-document-teardown.js'

/**
 * A body that is not JSON is refused as that, rather than read as `{}` and
 * refused for whatever field the empty object happens to lack — a truncated
 * body that DID carry `kind` was answered "Invalid discriminator value".
 */
async function server() {
  const deps = makeTestDeps({
    documentStore: new InMemoryDocumentStore(),
    documentTeardown: inMemoryDocumentTeardown(),
  })
  // The workspace exists: a URL naming one that does not is refused before any
  // body is read, which would leave the refusals below unreached.
  await deps.documentIndex.createWorkspace({ workspaceId: 'ws-1' })
  const { app } = createServer(deps)
  return (path: string, body: string | undefined) =>
    app.request(`/api/v1/workspaces/ws-1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
}

const NOT_JSON = 'the request body is not valid JSON'

describe('/api/v1 POST bodies', () => {
  it.each([
    ['a truncated object', '{"path":"x","kind":"spatial"'],
    ['bare text', 'abc'],
    ['an empty body', undefined],
  ])('refuses %s on create as not JSON', async (_name, body) => {
    const post = await server()
    const res = await post('documents', body)
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json).toMatchObject({ error: 'invalid_body' })
    expect(apiErrorReason(json)).toBe(NOT_JSON)
  })

  it('refuses a truncated linkify body as not JSON', async () => {
    const post = await server()
    const res = await post(
      'documents/01ARZ3NDEKTSV4RRFFQ69G5FAV/linkify-mentions',
      '{"targetDocumentId":"',
    )
    expect(res.status).toBe(400)
    expect(apiErrorReason(await res.json())).toBe(NOT_JSON)
  })

  it.each([
    ['a string', '"abc"'],
    ['an array', '[1]'],
    ['null', 'null'],
  ])('reads %s as a body with no fields, so the schema names what is missing', async (_n, body) => {
    const post = await server()
    const res = await post('documents', body)
    expect(res.status).toBe(400)
    expect(apiErrorReason(await res.json())).not.toBe(NOT_JSON)
  })
})
