import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it } from 'vitest'
import { apiErrorBodySchema } from './api-errors.js'
import { createServer } from './create-server.js'
import { setLogSink } from './log.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'
import { unusedDocumentIndex } from './test-utils/unused-document-index.js'

/**
 * A throw no route anticipated answers the JSON refusal every other `/api/v1`
 * failure does, and reaches the log seam — Hono's default would have been a
 * `text/plain` body and a `console.error` of the raw error.
 */
const LIST = '/api/v1/workspaces/ws-1/documents'

function serverThrowing(error: unknown) {
  const documentIndex = {
    ...unusedDocumentIndex(),
    resolveWorkspace: () => {
      throw error
    },
  }
  return createServer(makeTestDeps({ documentStore: {} as never, documentIndex })).app
}

afterEach(() => setLogSink(() => {}))

describe('/api/v1 on an unhandled throw', () => {
  it('answers a JSON 500 internal_error that does not echo the error', async () => {
    const res = await serverThrowing(new Error('boom secret=abc123')).request(LIST)

    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json()
    expect(apiErrorBodySchema.parse(body)).toMatchObject({ error: 'internal_error' })
    expect(JSON.stringify(body)).not.toContain('abc123')
  })

  it('logs the error with the request through the log seam, once', async () => {
    const records: Parameters<Parameters<typeof setLogSink>[0]>[0][] = []
    setLogSink((record) => records.push(record))
    const error = new Error('boom')

    await serverThrowing(error).request(LIST)

    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      level: 'error',
      data: { err: error, method: 'GET', path: LIST },
    })
  })

  it('answers 503 database_busy, with when to retry, for a database that stayed locked', async () => {
    const busy = Object.assign(new Error('database stayed locked'), { code: 'SQLITE_BUSY' })

    const res = await serverThrowing(busy).request(LIST)

    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('1')
    expect(apiErrorBodySchema.parse(await res.json())).toMatchObject({ error: 'database_busy' })
  })

  it('logs a busy database at warning, since the caller is told to retry', async () => {
    const records: Parameters<Parameters<typeof setLogSink>[0]>[0][] = []
    setLogSink((record) => records.push(record))
    const busy = Object.assign(new Error('database stayed locked'), { code: 'SQLITE_BUSY' })

    await serverThrowing(busy).request(LIST)

    expect(records.map((r) => r.level)).toEqual(['warning'])
    expect(records[0]?.data).toMatchObject({ method: 'GET', path: LIST })
  })

  it('answers a thrown HTTPException with the response it carries, unlogged', async () => {
    const records: unknown[] = []
    setLogSink((record) => records.push(record))
    const teapot = new HTTPException(418, { res: new Response('short and stout', { status: 418 }) })

    const res = await serverThrowing(teapot).request(LIST)

    expect(res.status).toBe(418)
    expect(await res.text()).toBe('short and stout')
    expect(records).toEqual([])
  })
})
