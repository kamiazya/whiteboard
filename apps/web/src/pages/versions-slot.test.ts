import { describe, expect, it, vi } from 'vitest'
import type { VersionsBackend } from '../lib/versions-backend.js'
import { versionsSlot } from './versions-slot.js'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

const backendOf = () => ({
  list: vi.fn(),
  loadPast: vi.fn(),
  restore: vi.fn(),
  save: vi.fn(async () => ({ id: 'v1' })),
})

describe('versionsSlot', () => {
  it('saves under the document id and reports the version it made', async () => {
    const backend = backendOf()
    const slot = versionsSlot({
      backend: backend as unknown as VersionsBackend,
      workspaceId: 'w1',
      documentId: ID,
      announceRefresh: () => {},
    })

    expect(slot.enabled).toBe(true)
    await expect(slot.save('mark')).resolves.toEqual({
      workspaceId: 'w1',
      documentId: ID,
      versionId: 'v1',
    })
    expect(backend.save).toHaveBeenCalledWith('w1', ID, { label: 'mark' })
  })

  it('stays disabled and saves nothing while the listing has not named the document', async () => {
    const backend = backendOf()
    const slot = versionsSlot({
      backend: backend as unknown as VersionsBackend,
      workspaceId: 'w1',
      documentId: undefined,
      announceRefresh: () => {},
    })

    expect(slot.enabled).toBe(false)
    await expect(slot.save('mark')).rejects.toThrow('no versions backend')
    expect(backend.save).not.toHaveBeenCalled()
  })
})
