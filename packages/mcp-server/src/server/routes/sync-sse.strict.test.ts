import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiErrorReason } from '@kamiazya/whiteboard-server-core'
import { afterAll, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import { createSyncSseRouter } from './sync-sse.js'

setDataDirForTests(mkdtempSync(join(tmpdir(), 'wb-sse-strict-')))
afterAll(() => resetDataDirForTests())

// Validation answers before any stream is looked up, so no stream is opened.
const post = (route: 'subscribe' | 'message', body: Record<string, unknown>) =>
  createSyncSseRouter({ workspaceDocuments: { onUpdated: () => () => {} } }).request(
    `/api/sync/${route}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )

describe('a strict sync request refuses with the key it did not recognise', () => {
  it('subscribe', async () => {
    const res = await post('subscribe', { streamId: 's', subscribe: ['ws/doc'], zzz: 1 })

    expect(res.status).toBe(400)
    expect(apiErrorReason(await res.json())).toContain('zzz')
  })

  it('message, at the top level', async () => {
    const res = await post('message', {
      streamId: 's',
      doc: 'ws/doc',
      message: { type: 'client_ready' },
      zzz: 1,
    })

    expect(res.status).toBe(400)
    expect(apiErrorReason(await res.json())).toContain('zzz')
  })

  it('message, inside the frame it carries', async () => {
    const res = await post('message', {
      streamId: 's',
      doc: 'ws/doc',
      message: { type: 'client_ready', zzz: 1 },
    })

    expect(res.status).toBe(400)
    expect(apiErrorReason(await res.json())).toContain('zzz')
  })
})

describe('a sync request whose body is not JSON', () => {
  it.each(['subscribe', 'message'] as const)('is refused as such by %s', async (route) => {
    const res = await createSyncSseRouter({
      workspaceDocuments: { onUpdated: () => () => {} },
    }).request(`/api/sync/${route}`, { method: 'POST', body: '{not json' })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'invalid_body',
      message: 'the request body is not valid JSON',
    })
  })
})
