/**
 * Roundtrip serialization tests for the libraries api-contract schemas.
 *
 * Each test verifies three invariants:
 *   1. A well-formed value parses successfully.
 *   2. JSON stringify → parse → schema.parse produces an equal result
 *      (no field drift through the wire format).
 *   3. A malformed / missing-required value is rejected by safeParse.
 *
 * z.infer type alignment is checked at the TypeScript level by annotating
 * parsed results with the exported type aliases.
 */
import { describe, expect, it } from 'vitest'
import {
  installedLibrariesResponseSchema,
  addInstalledLibraryRequestSchema,
  removeInstalledLibraryRequestSchema,
  userLibraryContentSchema,
  userLibrarySummarySchema,
  listUserLibrariesResponseSchema,
  saveUserLibraryRequestSchema,
  saveUserLibraryResponseSchema,
  removeUserLibraryResponseSchema,
  userLibraryMetadataManifestSchema,
  setUserLibraryMetadataRequestSchema,
  deleteUserLibraryMetadataRequestSchema,
  type InstalledLibrariesResponse,
  type AddInstalledLibraryRequest,
  type RemoveInstalledLibraryRequest,
  type UserLibraryContent,
  type UserLibrarySummary,
  type ListUserLibrariesResponse,
  type SaveUserLibraryRequest,
  type SaveUserLibraryResponse,
  type RemoveUserLibraryResponse,
  type UserLibraryMetadataManifest,
  type SetUserLibraryMetadataRequest,
  type DeleteUserLibraryMetadataRequest,
} from './libraries.js'
import { roundtrip } from './roundtrip.test-helper.js'

describe('installedLibrariesResponseSchema', () => {
  const valid: InstalledLibrariesResponse = {
    urls: ['https://example.com/lib1.excalidrawlib', 'https://example.com/lib2.excalidrawlib'],
  }

  it('parses a well-formed object with urls array', () => {
    const result: InstalledLibrariesResponse = installedLibrariesResponseSchema.parse(valid)
    expect(result.urls).toHaveLength(2)
  })

  it('parses an empty urls array', () => {
    const result: InstalledLibrariesResponse = installedLibrariesResponseSchema.parse({ urls: [] })
    expect(result.urls).toEqual([])
  })

  it('roundtrip preserves all URLs', () => {
    const result: InstalledLibrariesResponse = roundtrip(installedLibrariesResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('parses a simulated route response (JSON stringify → parse → schema.parse)', () => {
    // Mirrors what the route returns: c.json({ urls: [...] })
    const wire = JSON.stringify({ urls: ['https://example.com/lib1.excalidrawlib'] })
    const result: InstalledLibrariesResponse = installedLibrariesResponseSchema.parse(
      JSON.parse(wire),
    )
    expect(result.urls).toEqual(['https://example.com/lib1.excalidrawlib'])
  })

  it('rejects a plain array (old incorrect shape)', () => {
    expect(
      installedLibrariesResponseSchema.safeParse(['https://example.com/lib1.excalidrawlib'])
        .success,
    ).toBe(false)
  })

  it('rejects missing urls field', () => {
    expect(installedLibrariesResponseSchema.safeParse({}).success).toBe(false)
  })

  it('rejects null', () => {
    expect(installedLibrariesResponseSchema.safeParse(null).success).toBe(false)
  })
})

describe('addInstalledLibraryRequestSchema', () => {
  const valid: AddInstalledLibraryRequest = { url: 'https://example.com/lib.excalidrawlib' }

  it('parses a well-formed value', () => {
    const result: AddInstalledLibraryRequest = addInstalledLibraryRequestSchema.parse(valid)
    expect(result.url).toBe('https://example.com/lib.excalidrawlib')
  })

  it('roundtrip preserves url', () => {
    const result: AddInstalledLibraryRequest = roundtrip(addInstalledLibraryRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects empty url', () => {
    expect(addInstalledLibraryRequestSchema.safeParse({ url: '' }).success).toBe(false)
  })

  it('rejects missing url', () => {
    expect(addInstalledLibraryRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('removeInstalledLibraryRequestSchema', () => {
  const valid: RemoveInstalledLibraryRequest = { url: 'https://example.com/lib.excalidrawlib' }

  it('parses a well-formed value', () => {
    const result: RemoveInstalledLibraryRequest = removeInstalledLibraryRequestSchema.parse(valid)
    expect(result.url).toBe('https://example.com/lib.excalidrawlib')
  })

  it('roundtrip preserves url', () => {
    const result: RemoveInstalledLibraryRequest = roundtrip(
      removeInstalledLibraryRequestSchema,
      valid,
    )
    expect(result).toEqual(valid)
  })

  it('rejects empty url', () => {
    expect(removeInstalledLibraryRequestSchema.safeParse({ url: '' }).success).toBe(false)
  })
})

describe('userLibraryContentSchema', () => {
  const valid: UserLibraryContent = { type: 'excalidrawlib' }

  it('parses a minimal well-formed value', () => {
    const result: UserLibraryContent = userLibraryContentSchema.parse(valid)
    expect(result.type).toBe('excalidrawlib')
  })

  it('roundtrip with library and libraryItems', () => {
    const withArrays: UserLibraryContent = {
      type: 'excalidrawlib',
      library: [{ id: 'el1' }],
      libraryItems: [{ id: 'item1' }],
    }
    const result: UserLibraryContent = roundtrip(userLibraryContentSchema, withArrays)
    expect(result).toEqual(withArrays)
  })

  it('passes through unknown fields (passthrough schema)', () => {
    const withExtra = { type: 'excalidrawlib', version: 2, source: 'catalog' }
    const result = userLibraryContentSchema.parse(withExtra)
    expect((result as Record<string, unknown>).version).toBe(2)
    expect((result as Record<string, unknown>).source).toBe('catalog')
  })

  it('rejects wrong type discriminant', () => {
    expect(userLibraryContentSchema.safeParse({ type: 'other' }).success).toBe(false)
  })

  it('rejects library as non-array', () => {
    expect(
      userLibraryContentSchema.safeParse({ type: 'excalidrawlib', library: 'bad' }).success,
    ).toBe(false)
  })
})

describe('userLibrarySummarySchema', () => {
  const valid: UserLibrarySummary = {
    name: 'My Library',
    path: '/libs/my.excalidrawlib',
    itemCount: 10,
  }

  it('parses a well-formed value', () => {
    const result: UserLibrarySummary = userLibrarySummarySchema.parse(valid)
    expect(result.itemCount).toBe(10)
  })

  it('roundtrip preserves all fields', () => {
    const result: UserLibrarySummary = roundtrip(userLibrarySummarySchema, valid)
    expect(result).toEqual(valid)
  })

  it('roundtrip with bytes: null', () => {
    const withNullBytes: UserLibrarySummary = { ...valid, bytes: null }
    const result: UserLibrarySummary = roundtrip(userLibrarySummarySchema, withNullBytes)
    expect(result.bytes).toBeNull()
  })

  it('roundtrip with bytes as number', () => {
    const withBytes: UserLibrarySummary = { ...valid, bytes: 1024 }
    const result: UserLibrarySummary = roundtrip(userLibrarySummarySchema, withBytes)
    expect(result.bytes).toBe(1024)
  })

  it('rejects negative itemCount', () => {
    expect(userLibrarySummarySchema.safeParse({ ...valid, itemCount: -1 }).success).toBe(false)
  })

  it('rejects negative bytes', () => {
    expect(userLibrarySummarySchema.safeParse({ ...valid, bytes: -100 }).success).toBe(false)
  })

  it('rejects missing name', () => {
    const { name: _omit, ...missing } = valid
    expect(userLibrarySummarySchema.safeParse(missing).success).toBe(false)
  })
})

describe('listUserLibrariesResponseSchema', () => {
  const summary: UserLibrarySummary = {
    name: 'Lib A',
    path: '/libs/a.excalidrawlib',
    itemCount: 5,
  }
  const valid: ListUserLibrariesResponse = { libraries: [summary] }

  it('parses a well-formed value', () => {
    const result: ListUserLibrariesResponse = listUserLibrariesResponseSchema.parse(valid)
    expect(result.libraries).toHaveLength(1)
  })

  it('roundtrip preserves libraries', () => {
    const result: ListUserLibrariesResponse = roundtrip(listUserLibrariesResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing libraries', () => {
    expect(listUserLibrariesResponseSchema.safeParse({}).success).toBe(false)
  })
})

describe('saveUserLibraryRequestSchema', () => {
  it('parses a well-formed value with object content', () => {
    const valid: SaveUserLibraryRequest = { content: { type: 'excalidrawlib', library: [] } }
    const result: SaveUserLibraryRequest = saveUserLibraryRequestSchema.parse(valid)
    expect(result.content).toBeDefined()
  })

  it('roundtrip preserves content', () => {
    const valid: SaveUserLibraryRequest = {
      content: { type: 'excalidrawlib', libraryItems: [{ id: 'a' }] },
    }
    const result: SaveUserLibraryRequest = roundtrip(saveUserLibraryRequestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects missing content (z.unknown() requires the key to be present)', () => {
    expect(saveUserLibraryRequestSchema.safeParse({}).success).toBe(false)
  })
})

describe('saveUserLibraryResponseSchema', () => {
  const valid: SaveUserLibraryResponse = { name: 'My Library', itemCount: 7 }

  it('parses a well-formed value', () => {
    const result: SaveUserLibraryResponse = saveUserLibraryResponseSchema.parse(valid)
    expect(result.itemCount).toBe(7)
  })

  it('roundtrip preserves fields', () => {
    const result: SaveUserLibraryResponse = roundtrip(saveUserLibraryResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('rejects negative itemCount', () => {
    expect(saveUserLibraryResponseSchema.safeParse({ name: 'x', itemCount: -1 }).success).toBe(
      false,
    )
  })
})

describe('removeUserLibraryResponseSchema', () => {
  const valid: RemoveUserLibraryResponse = {
    removed: 'My Library',
    remaining: ['Other Library'],
  }

  it('parses a well-formed value', () => {
    const result: RemoveUserLibraryResponse = removeUserLibraryResponseSchema.parse(valid)
    expect(result.removed).toBe('My Library')
  })

  it('roundtrip preserves fields', () => {
    const result: RemoveUserLibraryResponse = roundtrip(removeUserLibraryResponseSchema, valid)
    expect(result).toEqual(valid)
  })

  it('roundtrip with empty remaining', () => {
    const empty: RemoveUserLibraryResponse = { removed: 'Lib', remaining: [] }
    const result: RemoveUserLibraryResponse = roundtrip(removeUserLibraryResponseSchema, empty)
    expect(result.remaining).toEqual([])
  })

  it('rejects missing removed', () => {
    expect(removeUserLibraryResponseSchema.safeParse({ remaining: [] }).success).toBe(false)
  })
})

describe('userLibraryMetadataManifestSchema', () => {
  const valid: UserLibraryMetadataManifest = {
    version: 1,
    revision: 0,
    aliases: { 'item-1': 2 },
    notes: { 'item-1': 'use for walls' },
    scales: { 'item-1': 1.5 },
  }

  it('parses a well-formed value', () => {
    const result: UserLibraryMetadataManifest = userLibraryMetadataManifestSchema.parse(valid)
    expect(result.version).toBe(1)
  })

  it('roundtrip preserves all fields', () => {
    const result: UserLibraryMetadataManifest = roundtrip(userLibraryMetadataManifestSchema, valid)
    expect(result).toEqual(valid)
  })

  it('roundtrip with empty records', () => {
    const minimal: UserLibraryMetadataManifest = {
      version: 1,
      revision: 5,
      aliases: {},
      notes: {},
      scales: {},
    }
    const result: UserLibraryMetadataManifest = roundtrip(
      userLibraryMetadataManifestSchema,
      minimal,
    )
    expect(result).toEqual(minimal)
  })

  it('rejects version other than 1', () => {
    expect(userLibraryMetadataManifestSchema.safeParse({ ...valid, version: 2 }).success).toBe(
      false,
    )
  })

  it('rejects negative revision', () => {
    expect(userLibraryMetadataManifestSchema.safeParse({ ...valid, revision: -1 }).success).toBe(
      false,
    )
  })

  it('rejects non-finite scale value', () => {
    expect(
      userLibraryMetadataManifestSchema.safeParse({
        ...valid,
        scales: { 'item-1': Infinity },
      }).success,
    ).toBe(false)
  })
})

describe('setUserLibraryMetadataRequestSchema', () => {
  it('parses with only aliases', () => {
    const valid: SetUserLibraryMetadataRequest = { revision: 1, aliases: { 'item-1': 3 } }
    const result: SetUserLibraryMetadataRequest = setUserLibraryMetadataRequestSchema.parse(valid)
    expect(result.aliases).toEqual({ 'item-1': 3 })
  })

  it('parses with only notes', () => {
    const valid: SetUserLibraryMetadataRequest = { revision: 2, notes: { 'item-1': 'note' } }
    const result: SetUserLibraryMetadataRequest = setUserLibraryMetadataRequestSchema.parse(valid)
    expect(result.notes).toEqual({ 'item-1': 'note' })
  })

  it('parses with only scales', () => {
    const valid: SetUserLibraryMetadataRequest = { revision: 3, scales: { 'item-1': 2.0 } }
    const result: SetUserLibraryMetadataRequest = setUserLibraryMetadataRequestSchema.parse(valid)
    expect(result.scales).toEqual({ 'item-1': 2.0 })
  })

  it('roundtrip with all fields', () => {
    const valid: SetUserLibraryMetadataRequest = {
      revision: 4,
      aliases: { a: 1 },
      notes: { a: 'n' },
      scales: { a: 0.5 },
    }
    const result: SetUserLibraryMetadataRequest = roundtrip(
      setUserLibraryMetadataRequestSchema,
      valid,
    )
    expect(result).toEqual(valid)
  })

  it('rejects when none of aliases/notes/scales is present', () => {
    expect(setUserLibraryMetadataRequestSchema.safeParse({ revision: 1 }).success).toBe(false)
  })

  it('rejects negative revision', () => {
    expect(
      setUserLibraryMetadataRequestSchema.safeParse({ revision: -1, aliases: { a: 1 } }).success,
    ).toBe(false)
  })
})

describe('deleteUserLibraryMetadataRequestSchema', () => {
  it('parses with only aliasKeys', () => {
    const valid: DeleteUserLibraryMetadataRequest = { revision: 1, aliasKeys: ['item-1'] }
    const result: DeleteUserLibraryMetadataRequest =
      deleteUserLibraryMetadataRequestSchema.parse(valid)
    expect(result.aliasKeys).toEqual(['item-1'])
  })

  it('parses with only noteKeys', () => {
    const valid: DeleteUserLibraryMetadataRequest = { revision: 2, noteKeys: ['item-2'] }
    const result: DeleteUserLibraryMetadataRequest =
      deleteUserLibraryMetadataRequestSchema.parse(valid)
    expect(result.noteKeys).toEqual(['item-2'])
  })

  it('parses with only scaleKeys', () => {
    const valid: DeleteUserLibraryMetadataRequest = { revision: 3, scaleKeys: ['item-3'] }
    const result: DeleteUserLibraryMetadataRequest =
      deleteUserLibraryMetadataRequestSchema.parse(valid)
    expect(result.scaleKeys).toEqual(['item-3'])
  })

  it('roundtrip with all keys', () => {
    const valid: DeleteUserLibraryMetadataRequest = {
      revision: 5,
      aliasKeys: ['a'],
      noteKeys: ['b'],
      scaleKeys: ['c'],
    }
    const result: DeleteUserLibraryMetadataRequest = roundtrip(
      deleteUserLibraryMetadataRequestSchema,
      valid,
    )
    expect(result).toEqual(valid)
  })

  it('rejects when none of aliasKeys/noteKeys/scaleKeys is present', () => {
    expect(deleteUserLibraryMetadataRequestSchema.safeParse({ revision: 1 }).success).toBe(false)
  })
})
