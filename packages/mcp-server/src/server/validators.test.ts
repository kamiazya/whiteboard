import { describe, expect, it, vi } from 'vitest'
import {
  validateBranchName,
  validateExternalUrl,
  validateFileId,
  validateWorkspaceId,
  validateSlug,
  validateVersionId,
} from './validators.js'

describe('shared validators', () => {
  it('accepts valid session ids, slugs, and ids', async () => {
    expect(validateWorkspaceId('sess_1-abc')).toBe('sess_1-abc')
    expect(validateSlug('621/header-v2')).toBe('621/header-v2')
    expect(validateVersionId('ver-1')).toBe('ver-1')
    expect(validateFileId('file_1-abc')).toBe('file_1-abc')

    await expect(
      validateExternalUrl('https://example.com/lib.excalidrawlib', {
        lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
      }),
    ).resolves.toBeInstanceOf(URL)
  })

  it('rejects invalid route/store identifiers', () => {
    expect(() => validateWorkspaceId('../escape')).toThrow(/Invalid workspaceId/)
    expect(() => validateSlug('../escape')).toThrow(/Invalid slug/)
    expect(() => validateVersionId('bad.id')).toThrow(/Invalid version id/)
    expect(() => validateFileId('bad/id')).toThrow(/Invalid file id/)
  })

  it('accepts the canonical "main" branch name and normal branch names', () => {
    expect(validateBranchName('main')).toBe('main')
    expect(validateBranchName('feature-1')).toBe('feature-1')
  })

  it('rejects branch names that only differ from "main" by letter case', () => {
    // displayBranchName() renders exactly 'main' as 'Main'; a real branch
    // literally named 'Main' (or 'MAIN') would render identically and be
    // indistinguishable from the default branch in switch/rename/delete UI.
    expect(() => validateBranchName('Main')).toThrow(/Invalid branch name/)
    expect(() => validateBranchName('MAIN')).toThrow(/Invalid branch name/)
    expect(() => validateBranchName('mAin')).toThrow(/Invalid branch name/)
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
