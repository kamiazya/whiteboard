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

  it('wires the facet_set tool', () => {
    const { tools } = createServer({
      canvasDocStore: {} as never,
      workspaceIndex: {} as never,
      blobStore: {} as never,
    })
    expect(tools.facetSet.name).toBe('facet_set')
    expect(tools.facetSet.execute).toBeTypeOf('function')
  })
})
