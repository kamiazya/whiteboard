import { describe, expect, it, vi } from 'vitest'
import {
  validateCheckpointId,
  validateExternalUrl,
  validateFileId,
  validateSessionId,
  validateSlug,
  validateUserLibraryName,
  validateVersionId,
} from './validators.js'

describe('shared validators', () => {
  it('accepts valid session ids, slugs, ids, and user library names', async () => {
    expect(validateSessionId('sess_1-abc')).toBe('sess_1-abc')
    expect(validateSlug('621/header-v2')).toBe('621/header-v2')
    expect(validateCheckpointId('cp_1')).toBe('cp_1')
    expect(validateVersionId('ver-1')).toBe('ver-1')
    expect(validateFileId('file_1-abc')).toBe('file_1-abc')
    expect(validateUserLibraryName('icons.v1')).toBe('icons.v1')

    await expect(
      validateExternalUrl('https://example.com/lib.excalidrawlib', {
        lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
      }),
    ).resolves.toBeInstanceOf(URL)
  })

  it('rejects invalid route/store identifiers', () => {
    expect(() => validateSessionId('../escape')).toThrow(/Invalid sessionId/)
    expect(() => validateSlug('../escape')).toThrow(/Invalid slug/)
    expect(() => validateCheckpointId('bad/id')).toThrow(/Invalid checkpoint id/)
    expect(() => validateVersionId('bad.id')).toThrow(/Invalid version id/)
    expect(() => validateFileId('bad/id')).toThrow(/Invalid file id/)
    expect(() => validateUserLibraryName('../icons')).toThrow(/Invalid user library name/)
  })

  it('rejects unsafe external urls before fetch', async () => {
    await expect(validateExternalUrl('http://localhost/lib.excalidrawlib')).rejects.toThrow(
      /private or local/i,
    )
    await expect(validateExternalUrl('http://127.0.0.1/lib.excalidrawlib')).rejects.toThrow(
      /private or local/i,
    )
    await expect(validateExternalUrl('http://10.0.0.2/lib.excalidrawlib')).rejects.toThrow(
      /private or local/i,
    )
    await expect(validateExternalUrl('https://diagram.local/lib.excalidrawlib')).rejects.toThrow(
      /private or local/i,
    )
    await expect(
      validateExternalUrl('http://user:pass@example.com/lib.excalidrawlib'),
    ).rejects.toThrow(/credentials/i)
  })

  it('rejects hostnames whose DNS resolution includes a private address', async () => {
    await expect(
      validateExternalUrl('https://example.com/lib.excalidrawlib', {
        lookup: vi.fn(async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.2', family: 4 },
        ]),
      }),
    ).rejects.toThrow(/private or local/i)
  })
})
