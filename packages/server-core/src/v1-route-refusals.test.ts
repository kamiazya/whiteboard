import { describe, expect, it } from 'vitest'
import { apiErrorReason } from './api-errors.js'
import {
  SEEDED_MARKDOWN_ID,
  SEEDED_SPATIAL_ID,
  SEEDED_WORKSPACE_ID,
  seededServer,
} from './test-utils/seeded-workspace.js'

const ws = `/api/v1/workspaces/${SEEDED_WORKSPACE_ID}`

async function refusal(path: string) {
  const { app } = await seededServer()
  const res = await app.request(path)
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
