// A board's geometry is any finite number, so a PNG target past the pixel
// budget is the caller's to shrink — a 400 naming the limit, not a renderer
// failure. The renderer's own refusal is `headless-renderer.resvg-input.test.ts`.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiErrorReason } from '@kamiazya/whiteboard-server-core'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refuseOversizedTarget } from '../export/export-budget.js'
import { testStoreScope } from './_test-helpers.js'

let tempDir: string

vi.mock('../config.js', () => ({
  get DATA_DIR() {
    return tempDir
  },
  getDataDir: () => tempDir,
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

vi.mock('../store/document-store.js', () => ({
  workspaceRegistry: () => ({ listWorkspaces: async () => [] }),
}))

const mockExportCanvasHeadless = vi.fn()
vi.mock('../export/headless-export.js', () => ({
  exportCanvasHeadless: (args: unknown) => mockExportCanvasHeadless(args),
}))

const { createExportRouter } = await import('./export.js')

describe('a PNG export past the pixel budget', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-export-too-large-'))
    mockExportCanvasHeadless.mockReset()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('answers 400 invalid_request naming the limit', async () => {
    const refusal = (() => {
      try {
        refuseOversizedTarget('<svg width="1000000" height="1000000">', 8)
      } catch (err) {
        return err
      }
    })()
    expect(refusal).toBeInstanceOf(Error)
    mockExportCanvasHeadless.mockRejectedValue(refusal)
    const app = new Hono()
    app.route(
      '/',
      createExportRouter({
        liveDocuments: { exists: async () => true },
        scope: testStoreScope(tempDir),
      }),
    )
    const res = await app.request('/api/w/s1/document/board/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scale: 8 }),
    })
    expect(res.status).toBe(400)
    const body: unknown = await res.json()
    expect(body).toMatchObject({ error: 'invalid_request' })
    expect(apiErrorReason(body)).toContain('16384px a side')
    expect(mockExportCanvasHeadless).toHaveBeenCalledTimes(1)
  })
})
