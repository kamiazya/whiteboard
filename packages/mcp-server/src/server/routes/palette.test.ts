import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return join(tempDir, 'data')
  },
}))

const { createPaletteRouter } = await import('./palette.js')

describe('palette router', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'palette-route-test-'))
    await mkdir(join(tempDir, 'data'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function createApp() {
    const app = new Hono()
    app.route('/', createPaletteRouter())
    return app
  }

  it('returns an empty object for GET on an uninitialized palette', async () => {
    const res = await createApp().request('/api/workspaces/session1/palette')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ palette: {} })
  })

  it('merges and returns data on PUT', async () => {
    const app = createApp()
    const res = await app.request('/api/workspaces/session1/palette', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: { 'accent.target': '#1971c2' } }),
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      palette: { 'accent.target': '#1971c2' },
    })
  })

  it('deletes only the requested keys and returns the result on DELETE', async () => {
    const app = createApp()
    await app.request('/api/workspaces/session1/palette', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: { 'plan.a': '#dbeafe', 'accent.target': '#1971c2' } }),
    })
    const res = await app.request('/api/workspaces/session1/palette', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['plan.a'] }),
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      palette: { 'accent.target': '#1971c2' },
    })
  })

  it('also reads the palette through the canonical workspace route', async () => {
    const app = createApp()
    await app.request('/api/workspaces/session1/palette', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: { 'accent.target': '#1971c2' } }),
    })

    const res = await app.request('/api/workspaces/session1/palette')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      palette: { 'accent.target': '#1971c2' },
    })
  })
})
