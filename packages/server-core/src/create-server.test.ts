import { describe, expect, it } from 'vitest'
import { createServer } from './create-server.js'

describe('createServer', () => {
  it('returns an app', () => {
    const { app } = createServer({
      canvasDocStore: {} as never,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })
    expect(app).toBeDefined()
    expect(app.fetch).toBeTypeOf('function')
  })
})
