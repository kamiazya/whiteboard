import { TOKENS } from '@kamiazya/whiteboard-ports'
import { Container, ContainerModule } from 'inversify'
import { describe, expect, it } from 'vitest'
import { InMemoryBlobStore } from '../server/store/inmemory/in-memory-blob-store.js'
import { InMemoryDocumentStore } from '../server/store/inmemory/in-memory-document-store.js'
import { createContainer, resolveServerDeps } from './container.js'

describe('createContainer', () => {
  it('resolves TOKENS.DocumentStore to an InMemoryDocumentStore', () => {
    const container = createContainer()
    expect(container.get(TOKENS.DocumentStore)).toBeInstanceOf(InMemoryDocumentStore)
  })

  it('resolves TOKENS.BlobStore to an InMemoryBlobStore', () => {
    const container = createContainer()
    expect(container.get(TOKENS.BlobStore)).toBeInstanceOf(InMemoryBlobStore)
  })

  it('resolves each port to the same singleton instance across repeated calls', () => {
    const container = createContainer()

    expect(container.get(TOKENS.DocumentStore)).toBe(container.get(TOKENS.DocumentStore))
    expect(container.get(TOKENS.BlobStore)).toBe(container.get(TOKENS.BlobStore))
  })
})

describe('resolveServerDeps', () => {
  it('assembles ServerDeps from container.get(TOKENS.X) for both ports', () => {
    const container = createContainer()

    const deps = resolveServerDeps(container)

    expect(deps.documentStore).toBeInstanceOf(InMemoryDocumentStore)
    expect(deps.blobStore).toBeInstanceOf(InMemoryBlobStore)
    expect(deps.documentStore).toBe(container.get(TOKENS.DocumentStore))
  })

  it('throws a clear, descriptive error when a token is not bound in the container', () => {
    const emptyModule = new ContainerModule(() => {})
    const container = new Container()
    container.load(emptyModule)

    expect(() => resolveServerDeps(container)).toThrow(/DocumentStore/)
  })
})

describe('ports TOKENS identity', () => {
  it('is the same Symbol across separate imports (global registry)', async () => {
    const reimported = await import('@kamiazya/whiteboard-ports')
    expect(reimported.TOKENS.DocumentStore).toBe(TOKENS.DocumentStore)
    expect(typeof TOKENS.DocumentStore).toBe('symbol')
    expect(Symbol.for('whiteboard.ports.DocumentStore')).toBe(TOKENS.DocumentStore)
  })
})
