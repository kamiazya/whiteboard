import { describe, expect, it } from 'vitest'
import { promotedTrashBytesRequestSchema, promotedVersionRequestSchema } from './version-entry.js'

// The row-level half of the planes a promotion carries: the request's own
// top-level strictness is the daemon-client contract's to pin, and each
// row is judged here, where both the sender and the operation read it.

const version = {
  id: '01BRWVERSAAAAAAAAAAAAAAAA0',
  documentId: '01BRWAAAAAAAAAAAAAAAAAAAA0',
  createdAt: 1_000,
  auto: false,
  frontiers: 'AQID',
}
const trash = { documentId: '01BRWAAAAAAAAAAAAAAAAAAAA1', bytes: 'Ynl0ZXM' }

const versionAccepted = (row: object) => promotedVersionRequestSchema.safeParse(row).success
const trashAccepted = (row: object) => promotedTrashBytesRequestSchema.safeParse(row).success

describe('promotedVersionRequestSchema', () => {
  it('accepts a plain row and one restored from a keyable id', () => {
    expect(versionAccepted(version)).toBe(true)
    expect(versionAccepted({ ...version, restoredFrom: '01BRWVERSAAAAAAAAAAAAAAAA1' })).toBe(true)
  })

  it('refuses a restoredFrom the version store could not key', () => {
    expect(versionAccepted({ ...version, restoredFrom: 'not/an/id' })).toBe(false)
  })

  it('refuses a key the row does not name', () => {
    expect(versionAccepted({ ...version, attestation: {} })).toBe(false)
  })

  it('refuses a negative or fractional createdAt', () => {
    expect(versionAccepted({ ...version, createdAt: -1 })).toBe(false)
    expect(versionAccepted({ ...version, createdAt: 1.5 })).toBe(false)
  })
})

describe('promotedTrashBytesRequestSchema', () => {
  it('accepts the entry it names', () => {
    expect(trashAccepted(trash)).toBe(true)
  })

  it('refuses a key the entry does not name', () => {
    expect(trashAccepted({ ...trash, path: 'x' })).toBe(false)
  })
})
