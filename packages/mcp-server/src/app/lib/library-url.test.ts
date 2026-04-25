import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getHashLibraryUrl,
  getImportableLibraryUrl,
  getInstalledLibraryUrls,
} from './library-url.js'

describe('library URL policy', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts public https library URLs', () => {
    expect(getImportableLibraryUrl('https://example.com/lib.excalidrawlib')).toBe(
      'https://example.com/lib.excalidrawlib',
    )
  })

  it('rejects localhost, literal private IPs, .local, and credentials before fetch', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(getImportableLibraryUrl('http://localhost/lib.excalidrawlib')).toBeNull()
    expect(getImportableLibraryUrl('http://127.0.0.1/lib.excalidrawlib')).toBeNull()
    expect(getImportableLibraryUrl('https://diagram.local/lib.excalidrawlib')).toBeNull()
    expect(getImportableLibraryUrl('https://user:pass@example.com/lib.excalidrawlib')).toBeNull()

    expect(warn).toHaveBeenCalledTimes(4)
  })

  it('applies the same policy to installed-library restore and hash import', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(
      getInstalledLibraryUrls([
        'https://example.com/lib.excalidrawlib',
        'http://localhost/private.excalidrawlib',
      ]),
    ).toEqual(['https://example.com/lib.excalidrawlib'])
    expect(
      getHashLibraryUrl(
        '#addLibrary=https%3A%2F%2Fexample.com%2Flib.excalidrawlib',
      ),
    ).toBe('https://example.com/lib.excalidrawlib')
    expect(
      getHashLibraryUrl(
        '#addLibrary=http%3A%2F%2F127.0.0.1%2Fprivate.excalidrawlib',
      ),
    ).toBeNull()

    expect(warn).toHaveBeenCalledTimes(2)
  })
})
