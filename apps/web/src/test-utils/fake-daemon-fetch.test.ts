// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFakeDaemonFetch } from './fake-daemon-fetch.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const call = (url: string, init?: RequestInit) => fetch(`http://daemon.test${url}`, init)

describe('installFakeDaemonFetch addresses documents by id', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hands a hook the path of the row carrying the id, and 404s an id no row carries', async () => {
    const onDeleteDocument = vi.fn()
    installFakeDaemonFetch({
      workspaces: [{ workspaceId: 'w1' }],
      documentsByWorkspace: { w1: [{ path: 'boards/mood', documentId: ID }] },
      onDeleteDocument,
    })

    const known = await call(`/api/workspaces/w1/documents/${ID}`, { method: 'DELETE' })
    expect(known.status).toBe(200)
    expect(onDeleteDocument).toHaveBeenCalledExactlyOnceWith('w1', 'boards/mood')

    const unknown = await call('/api/workspaces/w1/documents/01ARZ3NDEKTSV4RRFFQ69G5FAW', {
      method: 'DELETE',
    })
    expect(unknown.status).toBe(404)
    expect(onDeleteDocument).toHaveBeenCalledTimes(1)
  })
})
