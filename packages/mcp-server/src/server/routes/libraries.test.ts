import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
}))

const { createLibrariesRouter } = await import('./libraries.js')

describe('libraries routes', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-libraries-route-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('PUT /api/user-libraries/:name stores a user library payload', async () => {
    const app = createLibrariesRouter()
    const payload = {
      type: 'excalidrawlib',
      version: 2,
      libraryItems: [{ id: 'item-1', elements: [] }],
    }

    const res = await app.request('/api/user-libraries/icons', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: payload }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ name: 'icons', itemCount: 1 })
  })

  it('PUT /api/user-libraries/:name rejects invalid JSON body with 400', async () => {
    const app = createLibrariesRouter()

    const res = await app.request('/api/user-libraries/icons', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{"content":',
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_body',
      message: 'JSON body required',
    })
  })

  it('PUT /api/user-libraries/:name rejects missing content with 400', async () => {
    const app = createLibrariesRouter()

    const res = await app.request('/api/user-libraries/icons', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_body',
      message: 'content is required',
    })
  })

  it('PUT /api/user-libraries/:name rejects invalid payload content with 400', async () => {
    const app = createLibrariesRouter()

    const res = await app.request('/api/user-libraries/icons', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: { type: 'excalidrawlib', version: 2 } }),
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_body',
      message: 'content must include libraryItems[] or library[]',
    })
  })

  it('GET /api/user-libraries returns saved libraries', async () => {
    const app = createLibrariesRouter()
    await app.request('/api/user-libraries/icons', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: {
          type: 'excalidrawlib',
          version: 2,
          libraryItems: [{ id: 'item-1', elements: [] }],
        },
      }),
    })

    const res = await app.request('/api/user-libraries')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { libraries: Array<{ name: string; itemCount: number }> }
    expect(body.libraries).toEqual([expect.objectContaining({ name: 'icons', itemCount: 1 })])
  })

  it('DELETE /api/user-libraries/:name removes a saved library', async () => {
    const app = createLibrariesRouter()
    await app.request('/api/user-libraries/icons', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: {
          type: 'excalidrawlib',
          version: 2,
          libraryItems: [{ id: 'item-1', elements: [] }],
        },
      }),
    })

    const res = await app.request('/api/user-libraries/icons', { method: 'DELETE' })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ removed: 'icons', remaining: [] })
  })

  it('GET /api/user-libraries/:name/metadata returns the default empty manifest when missing', async () => {
    const app = createLibrariesRouter()

    const res = await app.request('/api/user-libraries/icons/metadata')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      version: 1,
      revision: 0,
      aliases: {},
      notes: {},
      scales: {},
    })
  })

  it('POST /api/user-libraries/:name/metadata merges fields and returns the updated manifest', async () => {
    const app = createLibrariesRouter()

    const res = await app.request('/api/user-libraries/icons/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 0,
        aliases: { cloud_run: 13 },
        notes: { '13': 'preferred icon' },
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      version: 1,
      revision: 1,
      aliases: { cloud_run: 13 },
      notes: { '13': 'preferred icon' },
      scales: {},
    })
  })

  it('DELETE /api/user-libraries/:name/metadata deletes selected keys and returns the updated manifest', async () => {
    const app = createLibrariesRouter()
    await app.request('/api/user-libraries/icons/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 0,
        aliases: { cloud_run: 13, pubsub: 7 },
        notes: { '13': 'preferred icon' },
        scales: { '13': 1.25 },
      }),
    })

    const res = await app.request('/api/user-libraries/icons/metadata', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 1,
        aliasKeys: ['cloud_run'],
        scaleKeys: ['13'],
      }),
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      version: 1,
      revision: 2,
      aliases: { pubsub: 7 },
      notes: { '13': 'preferred icon' },
      scales: {},
    })
  })

  it('metadata routes surface revision conflicts with 409', async () => {
    const app = createLibrariesRouter()
    await app.request('/api/user-libraries/icons/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 0,
        aliases: { cloud_run: 13 },
      }),
    })

    const res = await app.request('/api/user-libraries/icons/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        revision: 0,
        aliases: { pubsub: 7 },
      }),
    })

    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toEqual({
      error: 'conflict',
      message: expect.stringContaining('revision mismatch'),
    })
  })

  it('returns the persisted urls on GET /api/workspaces/:workspaceId/libraries', async () => {
    const { addInstalledLibrary } = await import('../store/library-store.js')
    await addInstalledLibrary('workspace1', 'https://libraries.excalidraw.com/foo.excalidrawlib')
    const app = createLibrariesRouter()

    const res = await app.request('/api/workspaces/workspace1/libraries')

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      urls: ['https://libraries.excalidraw.com/foo.excalidrawlib'],
    })
  })

  it('does not collapse corrupt stored data into not_found on GET /api/user-libraries/:name', async () => {
    const app = createLibrariesRouter()
    await mkdir(join(tempDir, 'blobs', '.user-libraries'), { recursive: true })
    await writeFile(join(tempDir, 'blobs', '.user-libraries', 'icons.excalidrawlib'), 'not-json')

    const res = await app.request('/api/user-libraries/icons')

    expect(res.status).toBe(500)
    await expect(res.json()).resolves.toEqual({
      error: 'corrupt_stored_data',
      message: expect.stringContaining('icons.excalidrawlib'),
    })
  })

  it('POST /api/workspaces/:workspaceId/libraries returns { error, message } when url is missing', async () => {
    const app = createLibrariesRouter()
    const res = await app.request('/api/workspaces/workspace1/libraries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_body',
      message: 'url (string) is required',
    })
  })

  it('DELETE /api/workspaces/:workspaceId/libraries returns { error, message } when url is missing', async () => {
    const app = createLibrariesRouter()
    const res = await app.request('/api/workspaces/workspace1/libraries', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'invalid_body',
      message: 'url (string) is required',
    })
  })

  it('rejects invalid session ids, user library names, and unsafe library urls with 400', async () => {
    const app = createLibrariesRouter()

    const badSession = await app.request('/api/workspaces/bad.sid/libraries')
    expect(badSession.status).toBe(400)

    const badName = await app.request('/api/user-libraries/icons..bak')
    expect(badName.status).toBe(400)

    const badUrl = await app.request('/api/workspaces/session1/libraries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost/lib.excalidrawlib' }),
    })
    expect(badUrl.status).toBe(400)
  })
})
