import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LoroDoc } from 'loro-crdt'
import type { BinaryFileData, DataURL } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement, FileId } from '@excalidraw/excalidraw/element/types'
import { commitAfterUpload } from './commit-pipeline.js'

// Minimal test element.
function makeElement(id: string): ExcalidrawElement {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeColor: '#000000',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 0,
    isDeleted: false,
    boundElements: null,
    updated: 0,
    link: null,
    locked: false,
    index: 'a0',
  } as unknown as ExcalidrawElement
}

function makeFd(mimeType = 'image/png'): BinaryFileData {
  return {
    id: 'dummy' as FileId,
    mimeType: mimeType as BinaryFileData['mimeType'],
    dataURL: `data:${mimeType};base64,aGVsbG8=` as DataURL,
    created: Date.now(),
  }
}

describe('commitAfterUpload', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // Basic behavior.

  it('commits immediately when there are no new files', async () => {
    const doc = new LoroDoc()

    await commitAfterUpload([], doc, [makeElement('e1')], 'session1', 'canvas-a', vi.fn())

    const elems = doc.getMovableList('elements').toJSON() as { id: string }[]
    expect(elems).toHaveLength(1)
    expect(elems[0].id).toBe('e1')
  })

  it('commits after a successful upload when new files are present', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))

    const doc = new LoroDoc()
    const onSuccess = vi.fn()
    const entries: [string, BinaryFileData][] = [['file-x', makeFd()]]

    await commitAfterUpload(entries, doc, [makeElement('e1')], 'session1', 'canvas-a', onSuccess)

    expect(onSuccess).toHaveBeenCalledWith('file-x')
    const elems = doc.getMovableList('elements').toJSON() as { id: string }[]
    expect(elems).toHaveLength(1)
  })

  it('skips commit when onChange does not change the elements', async () => {
    const doc = new LoroDoc()
    const elements = [makeElement('e1')]

    await commitAfterUpload([], doc, elements, 'session1', 'canvas-a', vi.fn())

    const commitSpy = vi.spyOn(doc, 'commit')
    await commitAfterUpload([], doc, elements, 'session1', 'canvas-a', vi.fn())

    expect(commitSpy).not.toHaveBeenCalled()
    expect(doc.getMovableList('elements').toJSON() as unknown[]).toHaveLength(1)
  })

  // Stale-closure protection.

  it('commits only to the captured doc even after async upload completes', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))

    const docA = new LoroDoc() // Captured before the canvas switch.
    const docB = new LoroDoc() // Created after docRef.current changed.

    const entries: [string, BinaryFileData][] = [['file-a', makeFd()]]

    // Start with docA; the later upload completion should still commit there.
    await commitAfterUpload(entries, docA, [makeElement('e1')], 'session1', 'canvas-a', vi.fn())

    // Only docA should be updated.
    expect(docA.getMovableList('elements').toJSON() as unknown[]).toHaveLength(1)
    // docB, which became current later, must stay untouched.
    expect(docB.getMovableList('elements').toJSON() as unknown[]).toHaveLength(0)
  })

  it('does not commit when upload fails', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }))

    const doc = new LoroDoc()
    const entries: [string, BinaryFileData][] = [['file-a', makeFd()]]

    await expect(
      commitAfterUpload(entries, doc, [makeElement('e1')], 'session1', 'canvas-a', vi.fn()),
    ).rejects.toThrow('PUT /file/file-a failed: 500')

    // No commit should have happened.
    expect(doc.getMovableList('elements').toJSON() as unknown[]).toHaveLength(0)
  })

  // Canvas isolation: commitAfterUpload must use the workspaceId/slug it was given.
  // This is a contract test for the hook regenerating its closure after a canvas switch.

  it('uploads to the URL built from the passed workspaceId and slug', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))

    const doc = new LoroDoc()
    await commitAfterUpload(
      [['file-b', makeFd()]],
      doc,
      [makeElement('e1')],
      'session-2',
      'canvas-b',
      vi.fn(),
    )

    // The upload should target canvas-b.
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      '/api/canvas/session-2/canvas-b/file/file-b',
      expect.objectContaining({ method: 'PUT' }),
    )
  })
})
