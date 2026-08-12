import { describe, expect, it } from 'vitest'
import { createServer } from './create-server.js'

describe('createServer', () => {
  it('returns an app', () => {
    const { app } = createServer({
      canvasDocStore: {} as never,
      blobStore: {} as never,
    })
    expect(app).toBeDefined()
    expect(app.fetch).toBeTypeOf('function')
  })

  it('wires the facet_set tool', () => {
    const { tools } = createServer({
      canvasDocStore: {} as never,
      blobStore: {} as never,
    })
    expect(tools.facetSet.name).toBe('facet_set')
    expect(tools.facetSet.execute).toBeTypeOf('function')
  })

  it('wires the render/export tools with input and output schemas', () => {
    const { tools } = createServer({
      canvasDocStore: {} as never,
      blobStore: {} as never,
    })

    const expectations = [
      { tool: tools.canvasRenderSvg, name: 'canvas_render_svg' },
      { tool: tools.canvasDigest, name: 'canvas_digest' },
      { tool: tools.canvasExportOkf, name: 'canvas_export_okf' },
      { tool: tools.canvasExportJsonCanvas, name: 'canvas_export_json_canvas' },
    ]

    for (const { tool, name } of expectations) {
      expect(tool.name).toBe(name)
      expect(tool.execute).toBeTypeOf('function')
      expect(tool.inputSchema).toBeDefined()
      expect(tool.outputSchema).toBeDefined()
    }
  })
})
