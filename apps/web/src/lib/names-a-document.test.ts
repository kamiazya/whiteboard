import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { fileNode } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { namesADocument } from './names-a-document.js'

describe('namesADocument', () => {
  it('reads a stored picture as naming nothing, in a body and on a board', () => {
    const pictured: SpatialCanvas = {
      nodes: [fileNode({ id: 'i', x: 0, y: 0, width: 10, height: 10, file: 'asset:pic' })],
      edges: [],
    }
    expect(namesADocument({ bodies: ['![[asset:pic]] ![](asset:inline)'] })).toBe(false)
    expect(namesADocument({ canvases: [pictured] })).toBe(false)
    expect(namesADocument({ bodies: ['![[asset:pic]] and [[notes/a]]'] })).toBe(true)
  })
})
