/**
 * Name resolution for embeds reads through the PRODUCTION index — the
 * workspace tree behind the startup fold — so a tree-created document and a
 * pre-collapse legacy record (index row + content, nothing in the tree)
 * both answer with their name. The legacy case is served by the fold, not
 * by a second read path of its own.
 */
import { fileNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import 'fake-indexeddb/auto'
import { MAX_FILE_UPLOAD_BYTES } from '@kamiazya/whiteboard-daemon-client/api-contracts/files'
import { writeSpatialCanvas } from '@kamiazya/whiteboard-loro-adapter'
import { generateDocumentId, newImageRef, type SpatialCanvas } from '@kamiazya/whiteboard-model'
import { Loro } from 'loro-crdt'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearWhiteboardDb } from '../test-utils/browser-document.js'
import { claimIsolatedWhiteboardDb } from '../test-utils/isolated-whiteboard-db.js'
import { expectLoggedFailure } from '../test-utils/logged-failures.js'
import { seedRetiredFileRecord } from '../test-utils/seed-retired-sync-row.js'
import { seedTreeContent, seedTreeDocument } from '../test-utils/seed-workspace-content.js'
import { BrowserDocumentIndex } from './browser-document-index.js'
import { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { getBrowserWorkspaceId } from './browser-workspace-id.js'
import { transferFragmentImages } from './clipboard-images.js'
import {
  BROWSER_FILE_ADAPTER,
  loadBrowserReference,
  resetEmbedIndexForTests,
} from './document-embed-content.js'
import { RETIRED_PICTURE } from './document-file-contract.js'
import { DocumentFileStore } from './document-file-store.js'

claimIsolatedWhiteboardDb('document-embed-content')

describe('loadBrowserReference', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    resetEmbedIndexForTests()
  })

  it('resolves the name of a document the workspace tree holds', async () => {
    const index = new BrowserDocumentIndex()
    await index.createWorkspace({ workspaceId: getBrowserWorkspaceId() }).catch(() => {})
    const entry = await index.createDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/spec',
      kind: 'markdown',
      name: 'The Spec',
    })

    const source = await loadBrowserReference(entry.documentId)
    expect(source?.name).toBe('The Spec')
  })

  it('resolves the name of a legacy record through the fold, not a second read path', async () => {
    const entry = await seedTreeDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/old',
      kind: 'markdown',
      name: 'Old Note',
    })
    const doc = new Loro()
    doc.getText('body').insert(0, 'legacy body')
    await seedTreeContent(entry.documentId, doc.export({ mode: 'snapshot' }))

    const source = await loadBrowserReference(entry.documentId)
    expect(source).toEqual({ documentId: entry.documentId, body: 'legacy body', name: 'Old Note' })
  })

  it('a workspace that could not be OPENED is not a document with no content', async () => {
    // The other half of the same lie: the tree read failed, so the legacy
    // row's "no record here" is the only answer left — and on its own it
    // says nothing, because the place the content actually lives was never
    // reached.
    const entry = await seedTreeDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/tree-only',
      kind: 'markdown',
      name: 'Tree only',
    })
    const unreadableTree = vi
      .spyOn(BrowserWorkspaceDocs.prototype, 'open')
      .mockRejectedValue(new Error('the workspace record could not be opened'))
    try {
      await expect(loadBrowserReference(entry.documentId)).rejects.toThrow(/could not be read/)
      await expectLoggedFailure('referenced document load failed')
    } finally {
      unreadableTree.mockRestore()
    }
  })

  it('answers a spatial document with its canvas rather than an empty body', async () => {
    const entry = await seedTreeDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'boards/plan',
      kind: 'spatial',
      name: 'The Plan',
    })
    const canvas: SpatialCanvas = {
      nodes: [textNode({ id: 'n1', x: 0, y: 0, width: 200, height: 100, text: 'plan node' })],
      edges: [],
    }
    const doc = new Loro()
    writeSpatialCanvas(doc, canvas)
    await seedTreeContent(entry.documentId, doc.export({ mode: 'snapshot' }))

    const source = await loadBrowserReference(entry.documentId)
    expect(source).toEqual({ documentId: entry.documentId, name: 'The Plan', canvas })
  })
})

describe('BROWSER_FILE_ADAPTER, referenced documents', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
    resetEmbedIndexForTests()
  })

  // The name is the embed card's heading; without it the card falls back to
  // the raw reference.
  it('answers an embedded note with its workspace name and its body', async () => {
    const entry = await seedTreeDocument({
      workspaceId: getBrowserWorkspaceId(),
      path: 'notes/spec',
      kind: 'markdown',
      name: 'The Spec',
    })
    const doc = new Loro()
    doc.getText('body').insert(0, 'spec body')
    await seedTreeContent(entry.documentId, doc.export({ mode: 'snapshot' }))

    const loaded = await BROWSER_FILE_ADAPTER.loadDocument(entry.documentId)
    expect(loaded?.name).toBe('The Spec')
    expect(loaded?.body).toBe('spec body')
  })

  it('re-throws a store read that FAILED, so the canvas seam asks again', async () => {
    // The canvas's embeds read through this door, not `loadBrowserReference`,
    // and the contract is the same: `undefined` is cached as terminal.
    const failing = vi
      .spyOn(BrowserWorkspaceDocs.prototype, 'open')
      .mockRejectedValue(new Error('the workspace record could not be opened'))
    try {
      await expect(BROWSER_FILE_ADAPTER.loadDocument(generateDocumentId())).rejects.toThrow(
        /could not be read/,
      )
      await expectLoggedFailure('embedded document load failed')
    } finally {
      failing.mockRestore()
    }
  })

  it('answers undefined for a document the store does not hold', async () => {
    await expect(
      BROWSER_FILE_ADAPTER.loadDocument('01ARZ3NDEKTSV4RRFFQ69G5FBZ'),
    ).resolves.toBeUndefined()
  })
})

describe('BROWSER_FILE_ADAPTER, stored images', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  it('hands back the bytes of an image it stored, under the reference it answered', async () => {
    const stored = await BROWSER_FILE_ADAPTER.storeImage(
      new File([new Uint8Array([137, 80, 78, 71])], 'dot.png', { type: 'image/png' }),
    )
    if (!stored.ok) throw new Error(stored.reason)

    const blob = await BROWSER_FILE_ADAPTER.loadImageBlob(stored.ref)

    expect(blob === undefined ? undefined : [...new Uint8Array(await blob.arrayBuffer())]).toEqual([
      137, 80, 78, 71,
    ])
  })

  it('answers an image it never stored with no bytes and no URL', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL')
    try {
      await expect(
        BROWSER_FILE_ADAPTER.loadImageBlob('asset:never-stored'),
      ).resolves.toBeUndefined()
      await expect(BROWSER_FILE_ADAPTER.loadImageUrl('asset:never-stored')).resolves.toBeUndefined()
      expect(createObjectURL).not.toHaveBeenCalled()
    } finally {
      createObjectURL.mockRestore()
    }
  })

  it('rejects an image the store could not read, so the image seam asks again', async () => {
    // `undefined` is "no such picture" and is never asked again; a store that
    // merely failed to open is not that.
    const failing = vi
      .spyOn(DocumentFileStore.prototype, 'read')
      .mockResolvedValue({ kind: 'unreadable', error: new Error('the store could not be read') })
    try {
      await expect(BROWSER_FILE_ADAPTER.loadImageBlob('asset:held')).rejects.toThrow(
        'the store could not be read',
      )
      await expect(BROWSER_FILE_ADAPTER.loadImageUrl('asset:held')).rejects.toThrow(
        'the store could not be read',
      )
      await expectLoggedFailure('image asset load failed')
    } finally {
      failing.mockRestore()
    }
  })

  it('scopes its files to this origin, the one store every browser workspace shares', () => {
    expect(BROWSER_FILE_ADAPTER.fileScope).toBe(`browser:${location.origin}`)
  })
})

describe('BROWSER_FILE_ADAPTER, the upload policy', () => {
  beforeEach(async () => {
    await clearWhiteboardDb()
  })

  // The browser could hold any bytes, but a workspace moves to a daemon only
  // with what the daemon accepts — so the keeper itself refuses, and no
  // writer into the seam has to remember to ask first.
  it.each([
    [
      'a type the daemon does not store',
      new File([new Uint8Array(4)], 'p.bmp', { type: 'image/bmp' }),
    ],
    [
      'a picture over the upload ceiling',
      new File([new Uint8Array(MAX_FILE_UPLOAD_BYTES + 1)], 'p.png', { type: 'image/png' }),
    ],
  ])('refuses %s without writing it', async (_case, file) => {
    const put = vi.spyOn(DocumentFileStore.prototype, 'put')
    try {
      const stored = await BROWSER_FILE_ADAPTER.storeImage(file)
      expect(stored.ok).toBe(false)
      expect(put).not.toHaveBeenCalled()
    } finally {
      put.mockRestore()
    }
  })

  it('leaves an off-policy pasted picture out, saying why, and stores nothing', async () => {
    const put = vi.spyOn(DocumentFileStore.prototype, 'put')
    try {
      const { fragment, notice } = await transferFragmentImages(
        {
          nodes: [fileNode({ id: 'f', x: 0, y: 0, width: 10, height: 10, file: 'asset:p' })],
          edges: [],
          files: { 'asset:p': { mimeType: 'image/bmp', dataBase64: btoa('bmp') } },
        },
        {
          fileScope: BROWSER_FILE_ADAPTER.fileScope,
          readImage: BROWSER_FILE_ADAPTER.loadImageBlob,
          storeImage: BROWSER_FILE_ADAPTER.storeImage,
        },
      )
      expect(put).not.toHaveBeenCalled()
      expect(fragment.nodes).toEqual([])
      expect(notice).toBe(
        'A picture was left out of the paste: image/bmp is not supported. Images can be PNG, JPEG, GIF, WebP, SVG.',
      )
    } finally {
      put.mockRestore()
    }
  })
})

describe('BROWSER_FILE_ADAPTER, a picture saved in a retired form', () => {
  beforeEach(clearWhiteboardDb)

  it('answers the retired literal for the slot to label, and no bytes for a copy', async () => {
    const ref = newImageRef('old-picture')
    await seedRetiredFileRecord(ref, new Uint8Array([1, 2, 3]))

    await expect(BROWSER_FILE_ADAPTER.loadImageUrl(ref)).resolves.toBe(RETIRED_PICTURE)
    await expect(BROWSER_FILE_ADAPTER.loadImageBlob(ref)).resolves.toBeUndefined()
  })
})
