import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { type CapturedLogsHandle, captureLogsForTests } from '../log.js'
import { createServerModeStoredDataRedaction } from './server-mode-redaction.js'

const DEPENDENCY_TEXT = 'YAMLException at /srv/whiteboard/data/ws-1/doc.md line 3'

function answering(error: string, status: 409 | 500) {
  const app = new Hono()
  app.use('/api/*', createServerModeStoredDataRedaction())
  app.get('/api/x', (c) =>
    c.json({ error, message: `Document D cannot be read: ${DEPENDENCY_TEXT}` }, status),
  )
  return app
}

let capture: CapturedLogsHandle | undefined
afterEach(() => {
  capture?.restore()
  capture = undefined
})

// A document OKF cannot spell is answered with the serializer's own text,
// which on server mode reaches a member rather than the operator.
describe('server-mode answer redaction', () => {
  it.each([
    ['document_serialize_failed', 409],
    ['corrupt_stored_data', 500],
  ] as const)('answers %s with a fixed message and logs the detail', async (error, status) => {
    capture = captureLogsForTests('debug')
    const res = await answering(error, status).request('/api/x')
    const text = await res.text()
    expect(res.status).toBe(status)
    expect(JSON.parse(text)).toMatchObject({ error })
    expect(text).not.toContain('YAMLException')
    expect(text).not.toContain('/srv/')
    expect(JSON.stringify(capture.records)).toContain(DEPENDENCY_TEXT)
  })

  it('leaves a refusal of another code as the route wrote it', async () => {
    const res = await answering('document_has_descendants', 409).request('/api/x')
    expect(await res.json()).toMatchObject({ message: expect.stringContaining(DEPENDENCY_TEXT) })
  })
})
