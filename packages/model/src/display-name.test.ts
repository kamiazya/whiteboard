import { describe, expect, it } from 'vitest'
import {
  displayNameKey,
  folderNameRefusal,
  folderNameSchema,
  isSiblingDisplayNameTaken,
} from './display-name.js'
import { DOCUMENT_NAME_MAX_LENGTH } from './ids.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

describe('folderNameRefusal', () => {
  it('accepts an ordinary name, spaces and punctuation included', () => {
    expect(folderNameRefusal('Week 6')).toBeNull()
    expect(folderNameRefusal('Q3 — plans (draft)')).toBeNull()
    expect(folderNameRefusal('設計')).toBeNull()
  })

  it('refuses a blank name, which would display as nothing at all', () => {
    expect(folderNameRefusal('')).toMatch(/blank/)
    expect(folderNameRefusal('   ')).toMatch(/blank/)
  })

  it('refuses a "/", which separates folders in a path', () => {
    expect(folderNameRefusal('a/b')).toMatch(/"\/"/)
  })

  it('refuses a name past the bound every display name holds', () => {
    expect(folderNameRefusal('x'.repeat(DOCUMENT_NAME_MAX_LENGTH))).toBeNull()
    expect(folderNameRefusal('x'.repeat(DOCUMENT_NAME_MAX_LENGTH + 1))).toMatch(/at most/)
  })

  it('counts the bound in UTF-16 units, as every other name bound does', () => {
    expect(folderNameRefusal('😀'.repeat(DOCUMENT_NAME_MAX_LENGTH / 2))).toBeNull()
    expect(folderNameRefusal(`😀${'x'.repeat(DOCUMENT_NAME_MAX_LENGTH - 1)}`)).toMatch(/at most/)
  })

  it('is the schema the write contracts parse with', () => {
    expect(folderNameSchema.safeParse('Week 6').success).toBe(true)
    const refused = folderNameSchema.safeParse('a/b')
    expect(refused.success).toBe(false)
    expect(refused.error?.issues[0]?.message).toBe(folderNameRefusal('a/b'))
  })
})

/** The comparison alone: every sibling at the workspace root, where `x` is the target's path. */
const isDisplayNameTaken = (name: string, siblings: string[]) =>
  isSiblingDisplayNameTaken(
    siblings.map((shown, i) => ({ path: `s${i}`, name: shown })),
    { path: 'x', name },
  )

describe('the display-name comparison', () => {
  it('compares trimmed, case-insensitively', () => {
    expect(isDisplayNameTaken('week 6', ['Week 6'])).toBe(true)
    expect(isDisplayNameTaken('  WEEK 6 ', ['Week 6'])).toBe(true)
    expect(isDisplayNameTaken('Week 7', ['Week 6'])).toBe(false)
  })

  it('compares NFC-normalised, so a composed and a decomposed é are one name', () => {
    expect(isDisplayNameTaken('Café', ['Café'])).toBe(true)
  })

  it('finds nothing taken among no siblings', () => {
    expect(isDisplayNameTaken('Week 6', [])).toBe(false)
  })

  const nameArb = fc.string({ unit: fc.constantFrom(...'aAeÉé ́́x'.split('')), maxLength: 8 })

  fcTest.prop([nameArb], withDefaults())('is idempotent as a key', (name) => {
    expect(displayNameKey(displayNameKey(name))).toBe(displayNameKey(name))
  })

  fcTest.prop([nameArb], withDefaults())(
    'finds a name among its padded, recased and decomposed variants',
    (name) => {
      expect(isDisplayNameTaken(` ${name} `, [name.normalize('NFD')])).toBe(true)
      expect(isDisplayNameTaken(name.toUpperCase(), [name])).toBe(true)
    },
  )
})

describe('isSiblingDisplayNameTaken', () => {
  const siblings = [
    { path: 'a/week-6', name: 'Week 6' },
    { path: 'a/plans' },
    { path: 'a/deep/inner', name: 'Inner' },
    { path: 'b/elsewhere', name: 'Elsewhere' },
    { path: 'top', name: 'Top' },
  ]

  it('compares against what each direct sibling shows: its name, else its segment', () => {
    expect(isSiblingDisplayNameTaken(siblings, { path: 'a/new', name: 'week 6' })).toBe(true)
    expect(isSiblingDisplayNameTaken(siblings, { path: 'a/new', name: 'Plans' })).toBe(true)
  })

  it('looks only under the same parent, never deeper or in another folder', () => {
    expect(isSiblingDisplayNameTaken(siblings, { path: 'a/new', name: 'Inner' })).toBe(false)
    expect(isSiblingDisplayNameTaken(siblings, { path: 'a/new', name: 'Elsewhere' })).toBe(false)
  })

  it('treats the workspace root as a parent like any other', () => {
    expect(isSiblingDisplayNameTaken(siblings, { path: 'new', name: 'top' })).toBe(true)
    expect(isSiblingDisplayNameTaken(siblings, { path: 'new', name: 'Week 6' })).toBe(false)
  })
})
