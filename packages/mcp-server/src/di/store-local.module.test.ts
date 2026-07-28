import type { BlobStore, CanvasDocStore, WorkspaceIndex } from '@kamiazya/whiteboard-canvas-ports'
import { TOKENS } from '@kamiazya/whiteboard-canvas-ports'
import { Container } from 'inversify'
import { describe, expect, it } from 'vitest'
import { FsBlobStore } from '../server/store/fs/fs-blob-store.js'
import { LibsqlCanvasDocStore } from '../server/store/libsql/libsql-canvas-doc-store.js'
import { LibsqlWorkspaceIndex } from '../server/store/libsql/libsql-workspace-index.js'
import { createStoreLocalModule } from './store-local.module.js'

describe('createStoreLocalModule', () => {
  it('binds all three store tokens to real implementations', () => {
    const fakeDb = {} as Parameters<typeof createStoreLocalModule>[0]['db']
    const mod = createStoreLocalModule({ db: fakeDb, blobDir: '/tmp/blobs' })

    const container = new Container()
    container.load(mod)

    const docStore = container.get<CanvasDocStore>(TOKENS.CanvasDocStore)
    const blobStore = container.get<BlobStore>(TOKENS.BlobStore)
    const wsIndex = container.get<WorkspaceIndex>(TOKENS.WorkspaceIndex)

    expect(docStore).toBeInstanceOf(LibsqlCanvasDocStore)
    expect(blobStore).toBeInstanceOf(FsBlobStore)
    expect(wsIndex).toBeInstanceOf(LibsqlWorkspaceIndex)
  })

  it('returns singletons for repeated gets', () => {
    const fakeDb = {} as Parameters<typeof createStoreLocalModule>[0]['db']
    const mod = createStoreLocalModule({ db: fakeDb, blobDir: '/tmp/blobs' })

    const container = new Container()
    container.load(mod)

    const a = container.get<CanvasDocStore>(TOKENS.CanvasDocStore)
    const b = container.get<CanvasDocStore>(TOKENS.CanvasDocStore)
    expect(a).toBe(b)
  })
})
