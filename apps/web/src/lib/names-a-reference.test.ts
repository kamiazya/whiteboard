import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { namesAReference } from './names-a-reference.js'

describe('namesAReference', () => {
  it('reads a stored picture as a reference, in a body and on a board', () => {
    const pictured: SpatialCanvas = {
      nodes: [fileNode({ id: 'i', x: 0, y: 0, width: 10, height: 10, file: 'asset:pic' })],
      edges: [],
    }
    expect(namesAReference({ bodies: ['![](asset:inline)'] })).toBe(true)
    expect(namesAReference({ canvases: [pictured] })).toBe(true)
    expect(namesAReference({ bodies: ['[[notes/a]]'] })).toBe(true)
  })

  it('reads content that names nothing as naming nothing', () => {
    const plain: SpatialCanvas = {
      nodes: [textNode({ id: 't', x: 0, y: 0, width: 10, height: 10, text: 'hi' })],
      edges: [],
    }
    expect(namesAReference({ bodies: ['# Just prose'] })).toBe(false)
    expect(namesAReference({ canvases: [plain] })).toBe(false)
  })
})
