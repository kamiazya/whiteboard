import { describe, expect, it } from 'vitest'
import {
  compareDocumentPaths,
  createWorkspaceInputSchema,
  documentEntrySchema,
  workspaceEntrySchema,
} from './document-index.js'
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

  // Pinned counterexample (CI seed 691127220): a TIE. `toBe` is Object.is,
  // and Object.is(+0, -0) is false — so asserting `sign(f(a,b))` equals
  // `-sign(f(b,a))` fails on any pair the comparator ties, purely from the
  // negation of zero. `===` (which treats ±0 as equal) states the actual
  // antisymmetry law; the comparator was never wrong.
  it('ties are antisymmetric too (equal paths compare to 0 both ways)', () => {
    expect(compareDocumentPaths('a', 'a')).toBe(0)
    const forward = Math.sign(compareDocumentPaths('a/b', 'a/b'))
    expect(forward === -forward).toBe(true)
  })

  fcTest.prop([pathArbitrary, pathArbitrary])('is antisymmetric', (left, right) => {
    const forward = Math.sign(compareDocumentPaths(left, right))
    const backward = Math.sign(compareDocumentPaths(right, left))
    expect(forward === -backward).toBe(true)
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
  it('accepts a ULID documentId with a path and a kind', () => {
    const parsed = documentEntrySchema.safeParse({
      documentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      path: 'plan/sub',
      kind: 'markdown',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects the nanoid row id the daemon mints for its own rows', () => {
    // ADR-0007 point 5: the nanoid is a storage detail, the ULID is the id.
    // Converging the two id spaces is what this schema is holding the line on.
    const parsed = documentEntrySchema.safeParse({
      documentId: 'Go1G4OcJKUBu',
      path: 'plan',
      kind: 'spatial',
    })
    expect(parsed.success).toBe(false)
  })
})

// ADR-0019's identity layers, their first consumer in this package. See
// document-index.ts's doc comment for why canonicalId is not a separate
// field: workspaceId already IS the canonical layer.
describe('createWorkspaceInputSchema (ADR-0019 segment/displayName widening)', () => {
  it('accepts a bare legacy workspaceId with neither field, as before', () => {
    expect(createWorkspaceInputSchema.safeParse({ workspaceId: 'ws-conformance' }).success).toBe(
      true,
    )
  })

  it('accepts a workspaceId carrying a valid segment and displayName', () => {
    const parsed = createWorkspaceInputSchema.safeParse({
      workspaceId: 'ws-conformance',
      segment: 'team-notes',
      displayName: 'Team notes',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a ULID-shaped segment, case-insensitively', () => {
    expect(
      createWorkspaceInputSchema.safeParse({
        workspaceId: 'ws',
        segment: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }).success,
    ).toBe(false)
    expect(
      createWorkspaceInputSchema.safeParse({
        workspaceId: 'ws',
        segment: '01arz3ndektsv4rrffq69g5fav',
      }).success,
    ).toBe(false)
  })

  it('rejects a segment containing a path separator', () => {
    expect(
      createWorkspaceInputSchema.safeParse({ workspaceId: 'ws', segment: 'a/b' }).success,
    ).toBe(false)
  })

  it('rejects an untrimmed or empty displayName', () => {
    expect(
      createWorkspaceInputSchema.safeParse({ workspaceId: 'ws', displayName: ' x ' }).success,
    ).toBe(false)
    expect(
      createWorkspaceInputSchema.safeParse({ workspaceId: 'ws', displayName: '' }).success,
    ).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(
      createWorkspaceInputSchema.safeParse({ workspaceId: 'ws', displayname: 'typo' }).success,
    ).toBe(false)
  })
})

describe('workspaceEntrySchema', () => {
  it('accepts a bare legacy row (Wave-2-unminted rows carry neither field)', () => {
    expect(workspaceEntrySchema.safeParse({ workspaceId: 'ws-conformance' }).success).toBe(true)
  })

  it('accepts a row carrying a valid segment and displayName', () => {
    const parsed = workspaceEntrySchema.safeParse({
      workspaceId: 'ws-conformance',
      segment: 'team-notes',
      displayName: 'Team notes',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a ULID-shaped segment', () => {
    expect(
      workspaceEntrySchema.safeParse({
        workspaceId: 'ws',
        segment: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }).success,
    ).toBe(false)
  })

  it('rejects an unknown key', () => {
    expect(workspaceEntrySchema.safeParse({ workspaceId: 'ws', displayname: 'typo' }).success).toBe(
      false,
    )
  })
})
