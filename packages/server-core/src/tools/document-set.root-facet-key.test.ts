import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { describe, expect, it } from 'vitest'
import { apiErrorReason } from '../api-errors.js'
import { createServer } from '../create-server.js'
import { makeTestDeps } from '../test-utils/make-test-deps.js'
import { inMemoryDocumentTeardown } from '../test-utils/unused-document-teardown.js'
import { wbDocumentCreate } from './document-crud.js'
import { wbDocumentCreateInputSchema } from './document-crud.schemas.js'
import { OkfParseError, parseWritableOkf } from './document-set.js'

const WS = 'root-facet'
// Spelled like a facet but written where no plugin reads: the same payload
// under `facets:` is refused by the registry, and here it would be stored
// unvalidated and have no effect at all.
const ROOT_FACET = '---\ntype: note\nvisual.symbol/v0:\n  kind: bogus\n---\nbody'
const NESTED_FACET = '---\ntype: note\nfacets:\n  visual.symbol/v0:\n    kind: bogus\n---\nbody'

describe('a facet key written at the root of the frontmatter', () => {
  it('is refused with a reason that says facets go under `facets:`', () => {
    const attempt = () => parseWritableOkf(ROOT_FACET)
    expect(attempt).toThrow(OkfParseError)
    expect(attempt).toThrow(/visual\.symbol\/v0.*under `facets:`/s)
  })

  it('refuses every such key, not only the first', () => {
    const markdown = '---\ntype: note\na.b/v1: 1\nc.d/v2: 2\n---\nbody'
    expect(() => parseWritableOkf(markdown)).toThrow(/a\.b\/v1.*c\.d\/v2/s)
  })

  it('leaves an unknown root key that is not facet-shaped alone', () => {
    // OKF §4.1: unknown keys are preserved, and only the facet spelling has a
    // meaning this write path would be silently ignoring.
    expect(() =>
      parseWritableOkf('---\ntype: note\nweird: 1\nvisual.symbol: x\n---\nb'),
    ).not.toThrow()
  })

  it('still reaches the registry when it is under `facets:`', () => {
    expect(() => parseWritableOkf(NESTED_FACET)).not.toThrow()
  })

  it('is refused by wb_document_create before the document exists', async () => {
    const deps = makeTestDeps()
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    await expect(
      wbDocumentCreate(deps, {
        workspaceId: WS,
        path: 'x',
        kind: 'markdown',
        markdown: ROOT_FACET,
      }),
    ).rejects.toThrow(/under `facets:`/)
    expect(await deps.documentIndex.listDocuments({ workspaceId: WS })).toEqual([])
  })

  it('is refused by POST /api/v1 documents as a parse refusal', async () => {
    const deps = makeTestDeps({
      documentStore: new InMemoryDocumentStore(),
      documentTeardown: inMemoryDocumentTeardown(),
    })
    await deps.documentIndex.createWorkspace({ workspaceId: WS })
    const { app } = createServer(deps)
    const res = await app.request(`/api/v1/workspaces/${WS}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'x', kind: 'markdown', markdown: ROOT_FACET }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ error: 'okf_parse_failed' })
    expect(apiErrorReason(body)).toMatch(/under `facets:`/)
  })

  it('is told to callers in the markdown field description', () => {
    const markdown = wbDocumentCreateInputSchema.options[0].shape.markdown
    expect(markdown.description).toContain('under `facets:`')
  })
})
