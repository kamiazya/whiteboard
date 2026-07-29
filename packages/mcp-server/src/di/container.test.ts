import { TOKENS } from '@kamiazya/whiteboard-canvas-ports'
import { Container, ContainerModule } from 'inversify'
import { describe, expect, it } from 'vitest'
import { InMemoryBlobStore } from '../server/store/inmemory/in-memory-blob-store.js'
import { InMemoryCanvasDocStore } from '../server/store/inmemory/in-memory-canvas-doc-store.js'
import { InMemoryWorkspaceIndex } from '../server/store/inmemory/in-memory-workspace-index.js'
import { createContainer, resolveServerDeps } from './container.js'

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

  it('resolves each port to the same singleton instance across repeated calls', () => {
    const container = createContainer()

    expect(container.get(TOKENS.CanvasDocStore)).toBe(container.get(TOKENS.CanvasDocStore))
    expect(container.get(TOKENS.BlobStore)).toBe(container.get(TOKENS.BlobStore))
    expect(container.get(TOKENS.WorkspaceIndex)).toBe(container.get(TOKENS.WorkspaceIndex))
  })
})

describe('resolveServerDeps', () => {
  it('assembles ServerDeps from container.get(TOKENS.X) for all three ports', () => {
    const container = createContainer()

    const deps = resolveServerDeps(container)

    expect(deps.canvasDocStore).toBeInstanceOf(InMemoryCanvasDocStore)
    expect(deps.workspaceIndex).toBeInstanceOf(InMemoryWorkspaceIndex)
    expect(deps.blobStore).toBeInstanceOf(InMemoryBlobStore)
    expect(deps.canvasDocStore).toBe(container.get(TOKENS.CanvasDocStore))
  })

  it('throws a clear, descriptive error when a token is not bound in the container', () => {
    const emptyModule = new ContainerModule(() => {})
    const container = new Container()
    container.load(emptyModule)

    expect(() => resolveServerDeps(container)).toThrow(/CanvasDocStore/)
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
