import type { BlobStore, DocumentStore } from '@kamiazya/whiteboard-ports'
import { TOKENS } from '@kamiazya/whiteboard-ports'
import { Container } from 'inversify'
import { describe, expect, it } from 'vitest'
import { FsBlobStore } from '../server/store/fs/fs-blob-store.js'
import { WorkspaceRoutedDocumentStore } from '../server/store/workspace-plane.js'
import { createStoreLocalModule } from './store-local.module.js'

describe('createStoreLocalModule', () => {
  it('binds both store tokens to real implementations', () => {
    const fakeDb = {} as Parameters<typeof createStoreLocalModule>[0]['db']
    const mod = createStoreLocalModule({ db: fakeDb, blobDir: '/tmp/blobs' })

    const container = new Container()
    container.load(mod)

    const docStore = container.get<DocumentStore>(TOKENS.DocumentStore)
    const blobStore = container.get<BlobStore>(TOKENS.BlobStore)

    expect(docStore).toBeInstanceOf(WorkspaceRoutedDocumentStore)
    expect(blobStore).toBeInstanceOf(FsBlobStore)
  })

  it('returns singletons for repeated gets', () => {
    const fakeDb = {} as Parameters<typeof createStoreLocalModule>[0]['db']
    const mod = createStoreLocalModule({ db: fakeDb, blobDir: '/tmp/blobs' })

    const container = new Container()
    container.load(mod)

    const a = container.get<DocumentStore>(TOKENS.DocumentStore)
    const b = container.get<DocumentStore>(TOKENS.DocumentStore)
    expect(a).toBe(b)
  })
})
