import { describe, expect, it } from 'vitest'
import { compareDocumentPaths, documentEntrySchema } from './document-index.js'
import { fc, fcTest } from './test-utils/fast-check.js'

describe('compareDocumentPaths', () => {
  it('keeps a subtree contiguous where whole-string comparison would split it', () => {
    // `-` is 0x2D and `/` is 0x2F, so sorting these as strings puts `a-b`
    // between `a` and its own child.
    const sorted = ['a-b', 'a/b', 'a', 'a/2', 'a/10'].sort(compareDocumentPaths)
    expect(sorted).toEqual(['a', 'a/10', 'a/2', 'a/b', 'a-b'])
    expect(['a-b', 'a/b', 'a'].sort()).toEqual(['a', 'a-b', 'a/b'])
  })

  it('sorts a path before every path it prefixes', () => {
    expect(compareDocumentPaths('x', 'x/y')).toBeLessThan(0)
    expect(compareDocumentPaths('x/y', 'x')).toBeGreaterThan(0)
  })

  it('compares segments by code point rather than numerically', () => {
    expect(compareDocumentPaths('a/10', 'a/2')).toBeLessThan(0)
  })

  const pathArbitrary = fc
    .array(fc.stringMatching(/^[a-z0-9-]{1,3}$/), { minLength: 1, maxLength: 3 })
    .map((segments) => segments.join('/'))

  fcTest.prop([pathArbitrary, pathArbitrary])('is antisymmetric', (left, right) => {
    expect(Math.sign(compareDocumentPaths(left, right))).toBe(
      -Math.sign(compareDocumentPaths(right, left)),
    )
  })

  fcTest.prop([pathArbitrary, pathArbitrary, pathArbitrary])(
    'is transitive, so a sort over it is a total order',
    (a, b, c) => {
      const sorted = [a, b, c].sort(compareDocumentPaths)
      for (let i = 0; i + 1 < sorted.length; i++) {
        expect(
          compareDocumentPaths(sorted[i] as string, sorted[i + 1] as string),
        ).toBeLessThanOrEqual(0)
      }
    },
  )
})

describe('documentEntrySchema', () => {
  it('accepts a ULID canvasId with a path and a kind', () => {
    const parsed = documentEntrySchema.safeParse({
      canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'plan/sub',
      kind: 'markdown',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects the nanoid row id the daemon mints for its own rows', () => {
    // ADR-0007 point 5: the nanoid is a storage detail, the ULID is the id.
    // Converging the two id spaces is what this schema is holding the line on.
    const parsed = documentEntrySchema.safeParse({
      canvasId: 'Go1G4OcJKUBu',
      path: 'plan',
      kind: 'spatial',
    })
    expect(parsed.success).toBe(false)
  })
})
