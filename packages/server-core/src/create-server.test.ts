import { describe, expect, it } from 'vitest'
import { createServer } from './create-server.js'
import { makeTestDeps } from './test-utils/make-test-deps.js'
import { unusedDocumentIndex } from './test-utils/unused-document-index.js'

describe('createServer', () => {
  it('returns an app', () => {
    const { app } = createServer(
      makeTestDeps({ documentStore: {} as never, documentIndex: unusedDocumentIndex() }),
    )
    expect(app).toBeDefined()
    expect(app.fetch).toBeTypeOf('function')
  })

  it('wires the wb_facet_set tool', () => {
    const { tools } = createServer(
      makeTestDeps({ documentStore: {} as never, documentIndex: unusedDocumentIndex() }),
    )
    expect(tools.facetSet.name).toBe('wb_facet_set')
    expect(tools.facetSet.execute).toBeTypeOf('function')
  })

  it('wires the render/export tools with input and output schemas', () => {
    const { tools } = createServer(
      makeTestDeps({ documentStore: {} as never, documentIndex: unusedDocumentIndex() }),
    )

    const expectations = [
      { tool: tools.canvasRenderSvg, name: 'wb_scene_render' },
      { tool: tools.canvasSnapshot, name: 'wb_canvas_snapshot' },
      { tool: tools.documentGet, name: 'wb_document_get' },
    ]

    for (const { tool, name } of expectations) {
      expect(tool.name).toBe(name)
      expect(tool.execute).toBeTypeOf('function')
      expect(tool.inputSchema).toBeDefined()
      expect(tool.outputSchema).toBeDefined()
    }
  })
})
