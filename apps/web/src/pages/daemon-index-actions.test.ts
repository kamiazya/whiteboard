import { describe, expect, it, vi } from 'vitest'
import * as daemonApiClient from '../lib/daemon-api-client.js'
import { deleteRows, duplicateRow } from './daemon-index-actions.js'

vi.mock('../lib/daemon-api-client.js', () => ({
  deleteDocument: vi.fn(),
  duplicateDocument: vi.fn(),
}))

const mockDelete = vi.mocked(daemonApiClient.deleteDocument)
const mockDuplicate = vi.mocked(daemonApiClient.duplicateDocument)

const BASE = 'http://127.0.0.1:3099'
const fetchFn = vi.fn() as unknown as typeof fetch
const rows = [
  { documentId: 'id-a', path: 'a', displayName: 'A', updatedAt: undefined },
  { documentId: 'id-b', path: 'b', displayName: 'B', updatedAt: undefined },
]

describe('duplicateRow', () => {
  it('rejects without a request when no row holds the path', async () => {
    mockDuplicate.mockClear()
    await expect(duplicateRow(fetchFn, BASE, 'w1', rows, 'missing', undefined)).rejects.toThrow(
      'No document is open to duplicate.',
    )
    expect(mockDuplicate).not.toHaveBeenCalled()
  })
})

describe('deleteRows', () => {
  it('counts an unlisted path as failed without a request', async () => {
    mockDelete.mockClear()
    mockDelete.mockResolvedValue({ ok: true })
    const outcome = await deleteRows(fetchFn, BASE, 'w1', rows, ['a', 'missing'])
    expect(mockDelete).toHaveBeenCalledTimes(1)
    expect(mockDelete).toHaveBeenCalledWith(fetchFn, BASE, 'w1', 'id-a')
    expect(outcome.failed).toEqual(['missing'])
  })

  it('reports a refused delete under its path, not its id', async () => {
    const refusal = new Error('refused')
    mockDelete.mockReset()
    mockDelete.mockResolvedValueOnce({ ok: true }).mockRejectedValueOnce(refusal)
    const outcome = await deleteRows(fetchFn, BASE, 'w1', rows, ['a', 'b'])
    expect(outcome.failed).toEqual(['b'])
    expect(outcome.lastError).toBe(refusal)
  })
})
