import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { useDaemonDocumentController } from './use-daemon-document-controller.js'

vi.mock('../lib/daemon-api-client.js', async (importOriginal) =>
  (await import('../test-utils/daemon-page-harness.js')).daemonApiClientMock(importOriginal, [
    'listWorkspaces',
    'listDocuments',
    'duplicateDocument',
    'deleteDocument',
  ]),
)

const mockListDocuments = vi.mocked(daemonApiClient.listDocuments)
const mockDuplicate = vi.mocked(daemonApiClient.duplicateDocument)
const mockDelete = vi.mocked(daemonApiClient.deleteDocument)

const BASE = 'http://127.0.0.1:3099'
const fetchFn = vi.fn() as unknown as typeof fetch
const ID_A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const rowA = { path: 'a', documentId: ID_A, updatedAt: '2026-01-01', kind: 'markdown' as const }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(daemonApiClient.listWorkspaces).mockResolvedValue({
    workspaces: [{ workspaceId: 'w1' }],
  })
  mockListDocuments.mockResolvedValue({ documents: [rowA] })
  mockDuplicate.mockResolvedValue({
    document: { documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAW', path: 'a-copy', kind: 'markdown' },
  })
  mockDelete.mockResolvedValue({ ok: true })
})

const open = async (path: string) => {
  const hook = renderHook(() =>
    useDaemonDocumentController({
      daemonBaseUrl: BASE,
      daemonFetch: fetchFn,
      workspaceId: 'w1',
      path,
    }),
  )
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

describe('useDaemonDocumentController addresses a document by its listed id', () => {
  it('duplicates the document the listing names, by id', async () => {
    const { result } = await open('a')

    await act(async () => {
      await result.current.duplicateDocument()
    })
    expect(mockDuplicate).toHaveBeenCalledWith(fetchFn, BASE, 'w1', ID_A, undefined)
  })

  it('deletes the document the listing names, by id', async () => {
    const { result } = await open('a')

    await act(async () => {
      await result.current.deleteDocument()
    })
    expect(mockDelete).toHaveBeenCalledWith(fetchFn, BASE, 'w1', ID_A)
  })

  it('throws before any request for a path the listing does not hold', async () => {
    const { result } = await open('zzz')

    await expect(result.current.duplicateDocument()).rejects.toThrow(
      'No document is open to duplicate.',
    )
    await expect(result.current.deleteDocument()).rejects.toThrow('No document is open to delete.')
    expect(mockDuplicate).not.toHaveBeenCalled()
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('throws once a refresh shows the document was deleted elsewhere', async () => {
    const { result } = await open('a')
    mockListDocuments.mockResolvedValue({ documents: [] })

    await act(async () => {
      await result.current.refreshDocuments()
    })
    await waitFor(() => expect(result.current.documents).toEqual([]))

    await expect(result.current.deleteDocument()).rejects.toThrow('No document is open to delete.')
    expect(mockDelete).not.toHaveBeenCalled()
  })
})
