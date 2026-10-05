import { SEARCH_QUERY_MAX_CHARS, TAGS_PER_ELEMENT_MAX } from '@kamiazya/whiteboard-model'
import {
  DocumentNotFoundError,
  SnapshotReassemblyError,
  StoredDocumentUnreadableError,
  WorkspaceSegmentTakenError,
} from '@kamiazya/whiteboard-ports'
import { describe, expect, it } from 'vitest'
import { apiErrorReason } from './api-errors.js'
import { createServer } from './create-server.js'
import { FakeDocumentStore } from './test-utils/fake-document-store.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'
import {
  SEEDED_MARKDOWN_ID,
  SEEDED_MARKDOWN_PATH,
  SEEDED_SPATIAL_ID,
  SEEDED_WORKSPACE_ID,
  seededServer,
} from './test-utils/seeded-workspace.js'
import { inMemoryDocumentTeardown } from './test-utils/unused-document-teardown.js'
import { DocumentSerializeError } from './tools/errors.js'

const ws = `/api/v1/workspaces/${SEEDED_WORKSPACE_ID}`

const json = { method: 'POST', headers: { 'content-type': 'application/json' } }

async function refusal(path: string, init?: RequestInit) {
  const { app } = await seededServer()
  const res = await app.request(path, init)
  const body: unknown = await res.json()
  return { status: res.status, body, reason: apiErrorReason(body) ?? '' }
}

describe('GET /api/v1 search query string', () => {
  it('refuses a key the route does not read, naming the keys it does', async () => {
    const { status, body, reason } = await refusal(`${ws}/search?q=plan&tags=x`)
    expect(status).toBe(400)
    expect(body).toMatchObject({ error: 'invalid_request' })
    expect(reason).toContain('"tags"')
    expect(reason).toContain('q, kind, tag, limit')
  })

  it('refuses a key that is not a spelling of any parameter', async () => {
    expect((await refusal(`${ws}/search?q=plan&bogus=1`)).status).toBe(400)
  })

  it('answers a request that uses only the keys it reads', async () => {
    const { status } = await refusal(`${ws}/search?q=plan&kind=markdown&tag=seed&limit=3`)
    expect(status).toBe(200)
  })

  it('names the wire parameters when neither words nor a filter were given', async () => {
    const { status, reason } = await refusal(`${ws}/search`)
    expect(status).toBe(400)
    expect(reason).toContain('`q`')
    expect(reason).toContain('`tag`')
    expect(reason).not.toContain('`query`')
    expect(reason).not.toContain('`tags`')
  })

  it('refuses words past the query bound, naming the wire parameter and the limit', async () => {
    const atBound = await refusal(`${ws}/search?q=${'a'.repeat(SEARCH_QUERY_MAX_CHARS)}`)
    expect(atBound.status).toBe(200)
    const { status, reason } = await refusal(
      `${ws}/search?q=${'a'.repeat(SEARCH_QUERY_MAX_CHARS + 1)}`,
    )
    expect(status).toBe(400)
    expect(reason).toMatch(/^q: /)
    expect(reason).toContain(`${SEARCH_QUERY_MAX_CHARS}-character limit`)
  })

  it('refuses more tag filters than one document may carry', async () => {
    const tags = Array.from({ length: TAGS_PER_ELEMENT_MAX + 1 }, (_, i) => `tag=t${i}`)
    const { status, reason } = await refusal(`${ws}/search?${tags.join('&')}`)
    expect(status).toBe(400)
    expect(reason).toContain(`${TAGS_PER_ELEMENT_MAX}-tag limit`)
  })

  it('names the wire parameter when the words are empty', async () => {
    const { status, reason } = await refusal(`${ws}/search?q=`)
    expect(status).toBe(400)
    expect(reason).toMatch(/^q: /)
  })
})

describe('GET /api/v1 routes that read no query string', () => {
  it.each([
    `${ws}/documents`,
    `${ws}/documents/${SEEDED_MARKDOWN_ID}`,
    `${ws}/documents/${SEEDED_MARKDOWN_ID}/backlinks`,
    `${ws}/documents/${SEEDED_MARKDOWN_ID}/okf`,
    `${ws}/document-tags`,
  ])('%s refuses an unknown key', async (path) => {
    const { status, reason } = await refusal(`${path}?bogus=1`)
    expect(status).toBe(400)
    expect(reason).toContain('"bogus"')
  })
})

describe('GET /api/v1 okf on a spatial document', () => {
  it('refuses with the kind mismatch the tools answer instead of fabricating a note', async () => {
    const { status, body, reason } = await refusal(`${ws}/documents/${SEEDED_SPATIAL_ID}/okf`)
    expect(status).toBe(409)
    expect(body).toMatchObject({ error: 'document_kind_mismatch' })
    expect(reason).toContain(`Document ${SEEDED_SPATIAL_ID} is a spatial document`)
  })

  it('still exports a markdown document', async () => {
    const { status } = await refusal(`${ws}/documents/${SEEDED_MARKDOWN_ID}/okf`)
    expect(status).toBe(200)
  })
})

describe('GET /api/v1 unknown query keys, in words', () => {
  it('names every key a route that reads no query string did not read', async () => {
    const { status, reason } = await refusal(`${ws}/documents?a=1&b=2`)
    expect(status).toBe(400)
    expect(reason).toBe('unknown query parameter "a", "b"; this route reads no query string')
  })

  it('names the keys a route reads when it reads some', async () => {
    const { reason } = await refusal(`${ws}/search?q=plan&tags=x&bogus=1`)
    expect(reason).toBe('unknown query parameter "tags", "bogus"; it reads q, kind, tag, limit')
  })
})

describe('/api/v1 workspace that names nothing', () => {
  it('is refused as a 404 before any route runs, in the words of a read', async () => {
    const { status, body, reason } = await refusal('/api/v1/workspaces/nope/documents')
    expect(status).toBe(404)
    expect(body).toMatchObject({ error: 'workspace_not_found' })
    expect(reason).toContain('Workspace not found: "nope"')
    expect(reason).toContain('Check the id against the workspaces you know')
    expect(reason).not.toContain('Pass createWorkspace: true on this')
  })

  it('may be named by the one request that can create it, which answers in the words of a create', async () => {
    const { status, reason } = await refusal('/api/v1/workspaces/nope/documents', {
      ...json,
      body: JSON.stringify({ path: 'a', kind: 'markdown' }),
    })
    expect(status).toBe(404)
    expect(reason).toContain('Pass createWorkspace: true on this wb_workspace_edit call')
  })

  it('answers a request that merely passes through documents in the words of a read', async () => {
    const { status, reason } = await refusal(
      `/api/v1/workspaces/nope/documents/${SEEDED_MARKDOWN_ID}/linkify-mentions`,
      { ...json, body: '{}' },
    )
    expect(status).toBe(404)
    expect(reason).toContain('Check the id against the workspaces you know')
    expect(reason).not.toContain('Pass createWorkspace: true on this')
  })
})

describe('POST /api/v1 document creating a workspace under a handle that cannot be one', () => {
  it('is refused as a 400 naming the handle, since only the caller can pick another', async () => {
    const { status, body, reason } = await refusal('/api/v1/workspaces/not_a_segment/documents', {
      ...json,
      body: JSON.stringify({ path: 'a', kind: 'markdown', createWorkspace: true }),
    })
    expect(status).toBe(400)
    expect(body).toMatchObject({ error: 'workspace_segment_unusable' })
    expect(reason).toContain('Cannot create workspace "not_a_segment"')
  })
})

describe('DELETE /api/v1 document with documents below it', () => {
  it('is refused as a 409 naming the descendants rather than escaping as a 500', async () => {
    const { app } = await seededServer()
    const created = await app.request(`${ws}/documents`, {
      ...json,
      body: JSON.stringify({ path: `${SEEDED_MARKDOWN_PATH}/child`, kind: 'markdown' }),
    })
    expect(created.status).toBe(201)

    const res = await app.request(`${ws}/documents/${SEEDED_MARKDOWN_ID}`, { method: 'DELETE' })
    const body: unknown = await res.json()
    expect(res.status).toBe(409)
    expect(body).toMatchObject({ error: 'document_has_descendants' })
    expect(apiErrorReason(body)).toContain(`"${SEEDED_MARKDOWN_PATH}" has descendants`)
  })
})

/** A store whose one record is there and cannot be read back, whatever the reason. */
class UnreadableStore extends FakeDocumentStore {
  constructor(private readonly failure: () => Error) {
    super()
  }
  override loadSnapshot(): never {
    throw this.failure()
  }
}

describe('GET /api/v1 document the store holds but cannot read', () => {
  async function readOf(failure: () => Error) {
    const store = new UnreadableStore(failure)
    store.documentIndex.seed({
      workspaceId: SEEDED_WORKSPACE_ID,
      documentId: SEEDED_MARKDOWN_ID,
      path: SEEDED_MARKDOWN_PATH,
      kind: 'markdown',
    })
    const { app } = createServer(
      makeTestDeps({ documentStore: store, documentIndex: store.documentIndex }),
    )
    const res = await app.request(`${ws}/documents/${SEEDED_MARKDOWN_ID}/okf`)
    const body: unknown = await res.json()
    return { status: res.status, body }
  }

  it('answers a malformed record as JSON naming corrupt stored data, not a bare 500', async () => {
    const { status, body } = await readOf(
      () => new StoredDocumentUnreadableError('malformed', 'header describes no snapshot'),
    )
    expect(status).toBe(500)
    expect(body).toMatchObject({
      error: 'corrupt_stored_data',
      message: 'header describes no snapshot',
    })
  })

  it('tells a record written by a newer build from a damaged one', async () => {
    const { status, body } = await readOf(
      () => new StoredDocumentUnreadableError('unsupported-version', 'envelope v9'),
    )
    expect(status).toBe(500)
    expect(body).toMatchObject({ error: 'stored_document_unsupported_version' })
  })

  it('answers an engine abort as document_engine_trap naming the document, not the workspace', async () => {
    const { status, body } = await readOf(() =>
      Object.assign(new Error('unreachable'), { name: 'RuntimeError' }),
    )
    expect(status).toBe(500)
    expect(body).toMatchObject({ error: 'document_engine_trap' })
    expect(apiErrorReason(body)).toContain(`while loading document ${SEEDED_MARKDOWN_ID};`)
    expect(apiErrorReason(body)).not.toContain(SEEDED_WORKSPACE_ID)
  })

  it('answers chunks that do not reassemble as corrupt stored data', async () => {
    const { status, body } = await readOf(
      () => new SnapshotReassemblyError('MISSING_CHUNK', 'chunk index 1 is missing'),
    )
    expect(status).toBe(500)
    expect(body).toMatchObject({ error: 'corrupt_stored_data' })
  })
})

describe('DELETE /api/v1 document whose index raises a refusal of its own', () => {
  // The index raises these from inside the delete, past the route's own
  // checks, so each is the route's answer to an error it did not predict.
  it.each([
    {
      error: () => new DocumentNotFoundError('ws-1', SEEDED_MARKDOWN_PATH),
      status: 404,
      code: 'document_not_found',
    },
    {
      error: () => new WorkspaceSegmentTakenError('plan'),
      status: 409,
      code: 'workspace_segment_taken',
    },
    {
      error: () => new DocumentSerializeError(SEEDED_MARKDOWN_ID, 'OKF Markdown', new Error('x')),
      status: 409,
      code: 'document_serialize_failed',
    },
  ])('answers $code as $status JSON', async ({ error, status, code }) => {
    const store = new FakeDocumentStore()
    store.documentIndex.seed({
      workspaceId: SEEDED_WORKSPACE_ID,
      documentId: SEEDED_MARKDOWN_ID,
      path: SEEDED_MARKDOWN_PATH,
      kind: 'markdown',
    })
    store.documentIndex.deleteDocument = () => {
      throw error()
    }
    const { app } = createServer(
      makeTestDeps({
        documentStore: store,
        documentIndex: store.documentIndex,
        documentTeardown: inMemoryDocumentTeardown(),
      }),
    )
    const res = await app.request(`${ws}/documents/${SEEDED_MARKDOWN_ID}`, { method: 'DELETE' })
    expect(res.status).toBe(status)
    expect(await res.json()).toMatchObject({ error: code })
  })
})
