import { constantRatioMeasureText } from '@kamiazya/whiteboard-canvas-render'
import { TOKENS } from '@kamiazya/whiteboard-ports'
import { InMemoryDocumentStore } from '@kamiazya/whiteboard-ports/test-utils'
import { Container, ContainerModule } from 'inversify'
import { LoroDoc } from 'loro-crdt'
import { describe, expect, it } from 'vitest'
import { EXPORT_FONT_FAMILY } from '../server/export/export-font.js'
import {
  _autoCompactTimerCountForTests,
  uninstallAutoCompact,
} from '../server/store/auto-compact.js'
import { peekDoc } from '../server/store/doc-cache.js'
import { getDoc } from '../server/store/document-store.js'
import { InMemoryBlobStore } from '../server/store/inmemory/in-memory-blob-store.js'
import { storeMemoryModule } from '../shared/test-utils/store-memory.module.js'
import { createContainer, resolveServerDeps } from './container.js'

describe('createContainer', () => {
  it('resolves TOKENS.DocumentStore to an InMemoryDocumentStore', () => {
    const container = createContainer(storeMemoryModule)
    expect(container.get(TOKENS.DocumentStore)).toBeInstanceOf(InMemoryDocumentStore)
  })

  it('resolves TOKENS.BlobStore to an InMemoryBlobStore', () => {
    const container = createContainer(storeMemoryModule)
    expect(container.get(TOKENS.BlobStore)).toBeInstanceOf(InMemoryBlobStore)
  })

  it('resolves each port to the same singleton instance across repeated calls', () => {
    const container = createContainer(storeMemoryModule)

    expect(container.get(TOKENS.DocumentStore)).toBe(container.get(TOKENS.DocumentStore))
    expect(container.get(TOKENS.BlobStore)).toBe(container.get(TOKENS.BlobStore))
  })
})

describe('resolveServerDeps', () => {
  it('assembles ServerDeps from container.get(TOKENS.X) for both ports', () => {
    const container = createContainer(storeMemoryModule)

    const deps = resolveServerDeps(container)

    expect(deps.documentStore).toBeInstanceOf(InMemoryDocumentStore)
    expect(deps.blobStore).toBeInstanceOf(InMemoryBlobStore)
    expect(deps.documentStore).toBe(container.get(TOKENS.DocumentStore))
  })

  it('supplies the real opentype measurer, not the constant-ratio fallback', async () => {
    const deps = resolveServerDeps(createContainer(storeMemoryModule))

    const measurer = await deps.textMeasurer?.()
    const measure = measurer?.measure
    expect(measure).toBeDefined()
    // The families ride with the measurer: what wb_scene_render may declare
    // is what this measurer holds a face for, the bundled family at least.
    expect(measurer?.measurableFamilies.has(EXPORT_FONT_FAMILY)).toBe(true)
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

describe('resolveServerDeps document teardown', () => {
  // There is deliberately NO "is documentTeardown defined?" test here: the
  // field is required on ServerDeps, so its absence is a compile error and
  // that assertion could not fail. What can still fail is wiring an inert
  // stub in place of the composition root's own teardown — which would put
  // wbDocumentDelete back to leaving thumbnails, blobs and a cached doc
  // behind, silently, with the tool still answering { deleted: true }.
  // Wired in the CONTAINER, not in the HTTP route registration. The old
  // saved-listener was installed from createDocumentRouter, so stdio MCP —
  // which never registers routes — had no subscriber at all. Asserting the
  // container supplies it is what stops that shape returning.
  it('supplies the write observer, so stdio MCP schedules compaction too', async () => {
    const deps = resolveServerDeps(createContainer(storeMemoryModule))
    uninstallAutoCompact()

    await deps.documentWritten?.({
      workspaceId: 'ws-container',
      documentId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
      doc: new LoroDoc(),
    })

    expect(_autoCompactTimerCountForTests()).toBe(1)
    uninstallAutoCompact()
  })

  it("supplies the composition root's own teardown, not an inert stub", async () => {
    const deps = resolveServerDeps(createContainer(storeMemoryModule))
    // A cached projection the teardown has to drop: an inert stub would run
    // the delete and leave it behind for the next create to inherit.
    await getDoc('ws-container', 'torn-down')
    expect(peekDoc('ws-container', 'torn-down')).toBeDefined()

    await deps.documentTeardown.around(
      {
        workspaceId: 'ws-container',
        documentId: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
        path: 'torn-down',
      },
      async () => true,
    )

    expect(peekDoc('ws-container', 'torn-down')).toBeUndefined()
  })
})
