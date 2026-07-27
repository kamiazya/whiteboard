import { TOKENS } from '@kamiazya/whiteboard-canvas-ports'
import { describe, expect, it } from 'vitest'
import { InMemoryBlobStore } from '../server/store/inmemory/in-memory-blob-store.js'
import { InMemoryCanvasDocStore } from '../server/store/inmemory/in-memory-canvas-doc-store.js'
import { InMemoryWorkspaceIndex } from '../server/store/inmemory/in-memory-workspace-index.js'
import { createContainer } from './container.js'

describe('createContainer', () => {
  it('resolves TOKENS.CanvasDocStore to an InMemoryCanvasDocStore', () => {
    const container = createContainer()
    expect(container.get(TOKENS.CanvasDocStore)).toBeInstanceOf(InMemoryCanvasDocStore)
  })

  it('resolves TOKENS.BlobStore to an InMemoryBlobStore', () => {
    const container = createContainer()
    expect(container.get(TOKENS.BlobStore)).toBeInstanceOf(InMemoryBlobStore)
  })

  it('resolves TOKENS.WorkspaceIndex to an InMemoryWorkspaceIndex', () => {
    const container = createContainer()
    expect(container.get(TOKENS.WorkspaceIndex)).toBeInstanceOf(InMemoryWorkspaceIndex)
  })
})

describe('canvas-ports TOKENS identity', () => {
  it('is the same Symbol across separate imports (global registry)', async () => {
    const reimported = await import('@kamiazya/whiteboard-canvas-ports')
    expect(reimported.TOKENS.CanvasDocStore).toBe(TOKENS.CanvasDocStore)
    expect(typeof TOKENS.CanvasDocStore).toBe('symbol')
    expect(Symbol.for('whiteboard.ports.CanvasDocStore')).toBe(TOKENS.CanvasDocStore)
  })
})
