import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'
import { TOKENS } from '@kamiazya/whiteboard-ports'
import { Container, ContainerModule } from 'inversify'
import { describe, expect, it } from 'vitest'
import { EXPORT_FONT_FAMILY } from '../server/export/export-font.js'
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

  it('supplies the real opentype measurer, not the constant-ratio fallback', async () => {
    const deps = resolveServerDeps(createContainer())

    const measure = await deps.measure?.()
    expect(measure).toBeDefined()
    const font = {
      family: EXPORT_FONT_FAMILY,
      fallbackChain: [],
      weight: 400,
      style: 'normal' as const,
      sizePx: 16,
    }
    // A real face's advance varies per glyph; the constant-ratio estimate
    // cannot tell 'iiii' from 'MMMM'. That difference is the whole point of
    // wiring this in — `wb_scene_render` now wraps text where the exporter
    // does — so assert it rather than merely that a function came back.
    expect(measure?.('iiii', font).advanceWidth).not.toBeCloseTo(
      measure?.('MMMM', font).advanceWidth ?? 0,
    )
    expect(constantRatioMeasureText('iiii', font).advanceWidth).toBeCloseTo(
      constantRatioMeasureText('MMMM', font).advanceWidth,
    )
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
    // lazy-import: a second import of the same specifier IS the subject —
    // the test proves TOKENS symbols survive separate imports via the global
    // symbol registry.
    const reimported = await import('@kamiazya/whiteboard-ports')
    expect(reimported.TOKENS.DocumentStore).toBe(TOKENS.DocumentStore)
    expect(typeof TOKENS.DocumentStore).toBe('symbol')
    expect(Symbol.for('whiteboard.ports.DocumentStore')).toBe(TOKENS.DocumentStore)
  })
})
