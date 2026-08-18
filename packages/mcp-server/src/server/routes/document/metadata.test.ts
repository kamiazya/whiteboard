import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return '/tmp/test-metadata'
  },
  getDataDir: () => '/tmp/test-metadata',
  WHITEBOARD_ROOT: '/tmp/whiteboard',
  REPO_ROOT: '/tmp',
}))

const { createDocumentMetadataRouter } = await import('./metadata.js')

describe('metadata router', () => {
  it('returns a Hono instance', () => {
    const app = createDocumentMetadataRouter()
    expect(app).toBeInstanceOf(Hono)
  })
})
