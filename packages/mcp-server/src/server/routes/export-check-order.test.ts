import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const mockExportCanvasHeadlessSvg = vi.fn()
vi.mock('../export/headless-export.js', () => ({
  exportCanvasHeadless: (args: unknown) => mockExportCanvasHeadless(args),
  exportCanvasHeadlessSvg: (args: unknown) => mockExportCanvasHeadlessSvg(args),
}))

const { createExportRouter } = await import('./export.js')
const { createDocumentSvgExportRouter } = await import('./document/export-svg.js')

const missing = async () => false

// Both formats are one request shape answered in one order; the table is what
// keeps a third format, or an edit to one route, from reordering only its own.
const ROUTES = [
  {
    format: 'png',
    action: 'export',
    mount: (app: Hono, scope: ReturnType<typeof testStoreScope>) =>
      app.route('/', createExportRouter({ liveDocuments: { exists: missing }, scope })),
  },
  {
    format: 'svg',
    action: 'export-svg',
    mount: (app: Hono, scope: ReturnType<typeof testStoreScope>) =>
      app.route('/', createDocumentSvgExportRouter({ liveDocuments: { exists: missing }, scope })),
  },
] as const

describe.each(ROUTES)('$format export refusal order on a missing document', (route) => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'whiteboard-export-order-test-'))
    mockExportCanvasHeadless.mockReset()
    mockExportCanvasHeadlessSvg.mockReset()
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function post(body: string | undefined) {
    const app = new Hono()
    route.mount(app, testStoreScope(tempDir))
    return app.request(`/api/w/s1/document/gone/${route.action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body }),
    })
  }

  it('tells the caller its body is malformed before it says the document is missing', async () => {
    const res = await post('{not json')
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_request' })
  })

  it('tells the caller its style names no registered theme, and which do, before it says the document is missing', async () => {
    const res = await post(JSON.stringify({ style: 'visual.nope' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('invalid_request')
    expect(body.message).toContain('visual.nope')
    expect(body.message).toContain('visual.sketch')
    expect(body.message).toContain('visual.neon')
    expect(mockExportCanvasHeadless).not.toHaveBeenCalled()
    expect(mockExportCanvasHeadlessSvg).not.toHaveBeenCalled()
  })

  it('lets a registered theme id, "clean" and "document" through to the missing-document answer', async () => {
    for (const style of ['visual.sketch', 'clean', 'document']) {
      const res = await post(JSON.stringify({ style }))
      expect(res.status, style).toBe(404)
    }
  })

  it('tells the caller its output path is refused before it says the document is missing', async () => {
    const res = await post(JSON.stringify({ outputPath: 'relative/out' }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'invalid_output_path' })
  })

  it('answers not_found for a well-formed request to a missing document, without rendering', async () => {
    const res = await post(undefined)
    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toMatchObject({ error: 'not_found' })
    expect(mockExportCanvasHeadless).not.toHaveBeenCalled()
    expect(mockExportCanvasHeadlessSvg).not.toHaveBeenCalled()
  })
})
