import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BinaryFileData, DataURL } from '@excalidraw/excalidraw/types'
import type { FileId } from '@excalidraw/excalidraw/element/types'
import { uploadFiles } from './upload-files.js'

function makeFd(mimeType: string, base64Data: string = 'aGVsbG8='): BinaryFileData {
  return {
    id: 'dummy' as FileId,
    mimeType: mimeType as BinaryFileData['mimeType'],
    dataURL: `data:${mimeType};base64,${base64Data}` as DataURL,
    created: Date.now(),
  }
}

describe('uploadFiles', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('calls onSuccess for every file when all uploads succeed', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))

    const onSuccess = vi.fn()
    const entries: [string, BinaryFileData][] = [
      ['file-a', makeFd('image/png')],
      ['file-b', makeFd('image/jpeg')],
    ]

    await uploadFiles(entries, 'session1', 'canvas-a', onSuccess)

    expect(onSuccess).toHaveBeenCalledTimes(2)
    expect(onSuccess).toHaveBeenCalledWith('file-a')
    expect(onSuccess).toHaveBeenCalledWith('file-b')
  })

  it('resolves when all uploads succeed', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }))

    const entries: [string, BinaryFileData][] = [['file-a', makeFd('image/png')]]

    await expect(uploadFiles(entries, 'session1', 'canvas-a', vi.fn())).resolves.toBeUndefined()
  })

  // Failure cases where callers must not continue to commitToLoro.

  it('rejects on HTTP 500 so callers can skip commit', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 500 }))

    const onSuccess = vi.fn()
    const entries: [string, BinaryFileData][] = [['file-a', makeFd('image/png')]]

    await expect(uploadFiles(entries, 'session1', 'canvas-a', onSuccess)).rejects.toThrow(
      'PUT /file/file-a failed: 500',
    )
    // onSuccess, which would queue the file for commit, must not run.
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('rejects on HTTP 404', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }))

    const entries: [string, BinaryFileData][] = [['file-a', makeFd('image/png')]]

    await expect(uploadFiles(entries, 'session1', 'canvas-a', vi.fn())).rejects.toThrow(
      'PUT /file/file-a failed: 404',
    )
  })

  it('rejects on network errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'))

    const onSuccess = vi.fn()
    const entries: [string, BinaryFileData][] = [['file-a', makeFd('image/png')]]

    await expect(uploadFiles(entries, 'session1', 'canvas-a', onSuccess)).rejects.toThrow()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('rejects when any file in a batch fails', async () => {
    const mockFetch = vi.mocked(fetch)
    // file-a succeeds, file-b fails.
    mockFetch
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))

    const onSuccess = vi.fn()
    const entries: [string, BinaryFileData][] = [
      ['file-a', makeFd('image/png')],
      ['file-b', makeFd('image/png')],
    ]

    await expect(uploadFiles(entries, 'session1', 'canvas-a', onSuccess)).rejects.toThrow(
      'PUT /file/file-b failed: 500',
    )
    // file-a already succeeded, so onSuccess('file-a') is expected.
    // The overall Promise still rejects, so the caller must skip commit.
    expect(onSuccess).toHaveBeenCalledWith('file-a')
    expect(onSuccess).not.toHaveBeenCalledWith('file-b')
  })

  it('resolves immediately when there are no entries', async () => {
    const entries: [string, BinaryFileData][] = []

    await expect(uploadFiles(entries, 'session1', 'canvas-a', vi.fn())).resolves.toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })
})
