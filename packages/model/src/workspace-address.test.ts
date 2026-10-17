import { describe, expect, it } from 'vitest'
import { canonicalUlidArbitrary, workspaceSegmentArbitrary } from './test-utils/arbitraries.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'
import {
  deriveUserHandle,
  formatWorkspaceAddress,
  namespaceHandleSchema,
  parseWorkspaceAddress,
  SINGLE_PERSON_NAMESPACE,
  userHandleSchema,
  type WorkspaceAddress,
  workspaceAddressInputSchema,
  workspaceAddressSchema,
} from './workspace-address.js'

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

/** Every casing of the reserved handle, since a URL reads `ME` as `me`. */
const meCasingArb = fc.constantFrom('me', 'Me', 'mE', 'ME')

const ulidShapedArb = fc
  .tuple(canonicalUlidArbitrary, fc.boolean())
  .map(([ulid, lower]) => (lower ? ulid.toLowerCase() : ulid))

const namespaceArb = fc.oneof(
  { weight: 3, arbitrary: workspaceSegmentArbitrary },
  { weight: 1, arbitrary: fc.constant(SINGLE_PERSON_NAMESPACE) },
)

/** A legacy daemon id: path-safe, `_` included, which no segment may hold. */
const legacyIdArb = fc
  .stringMatching(/^[a-zA-Z0-9_-]{1,24}$/)
  .filter((id) => !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id))

const addressArb: fc.Arbitrary<WorkspaceAddress> = fc.oneof(
  canonicalUlidArbitrary.map((workspaceId) => ({ form: 'id' as const, workspaceId })),
  fc
    .tuple(namespaceArb, workspaceSegmentArbitrary)
    .map(([namespace, segment]) => ({ form: 'qualified' as const, namespace, segment })),
  fc
    .oneof(workspaceSegmentArbitrary, legacyIdArb)
    .map((handle) => ({ form: 'bare' as const, handle })),
)

/** Dense on what the parser splits on and refuses: separators, `_`, case. */
const noisyArb = fc.string({ unit: fc.constantFrom(...'aM e-_/0Z.'.split('')), maxLength: 12 })

/** Names dense on the arrangements derivation must survive: `me`, ULIDs, scripts it cannot spell. */
const displayNameArb = fc.oneof(
  fc.string({ unit: fc.constantFrom(...'aMe1 -_/。設'.split('')), maxLength: 16 }),
  meCasingArb.map((me) => ` ${me} `),
  ulidShapedArb,
  fc.string({ minLength: 201, maxLength: 260, unit: fc.constant('a') }),
)

describe('user handle', () => {
  it('reserves `me` in every casing, while an address may still spell it', () => {
    for (const me of ['me', 'Me', 'mE', 'ME']) {
      expect(userHandleSchema.safeParse(me).success).toBe(false)
    }
    expect(namespaceHandleSchema.safeParse('me').success).toBe(true)
    expect(userHandleSchema.safeParse('meg').success).toBe(true)
  })

  fcTest.prop([ulidShapedArb], withDefaults())('refuses a ULID-shaped handle', (ulid) => {
    expect(userHandleSchema.safeParse(ulid).success).toBe(false)
    expect(namespaceHandleSchema.safeParse(ulid).success).toBe(false)
    expect(parseWorkspaceAddress(`${ulid}/design`)).toBeNull()
  })

  it('derives a handle from a display name, and falls back where the name spells none', () => {
    expect(deriveUserHandle('Alice Liddell')).toBe('alice-liddell')
    expect(deriveUserHandle('設計')).toBe('user')
    expect(deriveUserHandle('Me')).toBe('user')
    expect(deriveUserHandle(ULID)).toBe('user')
  })

  fcTest.prop([displayNameArb], withDefaults({ numRuns: 500 }))(
    'derivation always yields a handle a user may hold',
    (displayName) => {
      expect(userHandleSchema.safeParse(deriveUserHandle(displayName)).success).toBe(true)
    },
  )

  // The registry makes a derived handle unique by suffixing it (`firstFreeSegment`),
  // which re-checks the SEGMENT grammar only. That is enough because a suffix
  // carries a hyphen, which neither `me` nor a ULID can hold.
  fcTest.prop([displayNameArb, fc.integer({ min: 2, max: 999 })], withDefaults())(
    'a suffixed derived handle within the segment bound is still a valid handle',
    (displayName, n) => {
      const candidate = `${deriveUserHandle(displayName)}-${n}`
      if (candidate.length > 200) return
      expect(userHandleSchema.safeParse(candidate).success).toBe(true)
    },
  )
})

describe('parseWorkspaceAddress', () => {
  it('tells the three forms apart', () => {
    expect(parseWorkspaceAddress(ULID)).toEqual({ form: 'id', workspaceId: ULID })
    expect(parseWorkspaceAddress('alice/design')).toEqual({
      form: 'qualified',
      namespace: 'alice',
      segment: 'design',
    })
    expect(parseWorkspaceAddress('me/design')).toEqual({
      form: 'qualified',
      namespace: 'me',
      segment: 'design',
    })
    expect(parseWorkspaceAddress('design')).toEqual({ form: 'bare', handle: 'design' })
    expect(parseWorkspaceAddress('V1StGXR8_Z5jdHi6B-myT')).toEqual({
      form: 'bare',
      handle: 'V1StGXR8_Z5jdHi6B-myT',
    })
  })

  it('refuses a bare address holding a canonical id, which would read back as the id form', () => {
    expect(workspaceAddressSchema.safeParse({ form: 'bare', handle: ULID }).success).toBe(false)
  })

  it('refuses what names no form', () => {
    for (const address of [
      '',
      '/',
      'alice/',
      '/design',
      'a/b/c',
      'alice/my_ws',
      'a.b',
      `a/${ULID}`,
    ]) {
      expect(parseWorkspaceAddress(address), address).toBeNull()
    }
  })

  fcTest.prop([addressArb], withDefaults({ numRuns: 500 }))(
    'parse undoes format for every address',
    (address) => {
      expect(parseWorkspaceAddress(formatWorkspaceAddress(address))).toEqual(address)
    },
  )

  fcTest.prop(
    [fc.oneof(addressArb.map(formatWorkspaceAddress), noisyArb)],
    withDefaults({ numRuns: 500 }),
  )('answers null or a schema-valid address that formats back to its input', (input) => {
    const address = parseWorkspaceAddress(input)
    if (address === null) return
    expect(workspaceAddressSchema.safeParse(address).success).toBe(true)
    expect(formatWorkspaceAddress(address)).toBe(input)
  })
})

describe('workspaceAddressInputSchema', () => {
  // The schema a tool publishes is a regex and the parser is not, so this is
  // what keeps a tool from refusing at its boundary an address it resolves.
  fcTest.prop(
    [fc.oneof(addressArb.map(formatWorkspaceAddress), noisyArb)],
    withDefaults({ numRuns: 500 }),
  )('admits every address the parser reads a form from', (input) => {
    if (parseWorkspaceAddress(input) === null) return
    expect(workspaceAddressInputSchema.safeParse(input).success).toBe(true)
  })

  it('refuses more than one separator and characters no form holds', () => {
    for (const input of ['', 'a/b/c', '/design', 'alice/', 'a.b', 'a b']) {
      expect(workspaceAddressInputSchema.safeParse(input).success, input).toBe(false)
    }
  })
})
