import { describe, expect, it } from 'vitest'
import {
  displayNameKey,
  firstDistinctUnnamedPath,
  folderNameRefusal,
  folderNameSchema,
  movedDisplayNameTaken,
  shownName,
  siblingDisplayNameTaken,
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
  siblingDisplayNameTaken(
    'document',
    siblings.map((shown, i) => ({ path: `s${i}`, name: shown })),
    { path: 'x', name },
  ) !== undefined

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

  // A sibling's blank name shows its segment instead (`shownName`), so the
  // comparison is asked only of names a sibling can show.
  const shownArb = nameArb.filter((name) => name.trim() !== '')

  fcTest.prop([shownArb], withDefaults())(
    'finds a name among its padded, recased and decomposed variants',
    (name) => {
      expect(isDisplayNameTaken(` ${name} `, [name.normalize('NFD')])).toBe(true)
      expect(isDisplayNameTaken(name.toUpperCase(), [name])).toBe(true)
    },
  )
})

describe('siblingDisplayNameTaken', () => {
  const siblings = [
    { path: 'a/week-6', name: 'Week 6' },
    { path: 'a/plans' },
    { path: 'a/deep/inner', name: 'Inner' },
    { path: 'b/elsewhere', name: 'Elsewhere' },
    { path: 'top', name: 'Top' },
  ]

  it('answers what the direct sibling shows: its name, else its segment', () => {
    expect(siblingDisplayNameTaken('document', siblings, { path: 'a/new', name: 'week 6' })).toBe(
      'Week 6',
    )
    expect(siblingDisplayNameTaken('document', siblings, { path: 'a/new', name: 'Plans' })).toBe(
      'plans',
    )
  })

  it('looks only under the same parent, never deeper or in another folder', () => {
    expect(
      siblingDisplayNameTaken('document', siblings, { path: 'a/new', name: 'Inner' }),
    ).toBeUndefined()
    expect(
      siblingDisplayNameTaken('document', siblings, { path: 'a/new', name: 'Elsewhere' }),
    ).toBeUndefined()
  })

  it('treats the workspace root as a parent like any other', () => {
    expect(siblingDisplayNameTaken('document', siblings, { path: 'new', name: 'top' })).toBe('Top')
    expect(
      siblingDisplayNameTaken('document', siblings, { path: 'new', name: 'Week 6' }),
    ).toBeUndefined()
  })
})

describe('movedDisplayNameTaken', () => {
  const staying = [{ path: 'week/plan', name: 'Q3 Planning' }, { path: 'week/notes' }]

  it('answers the name the sibling shows where the entry lands', () => {
    expect(
      movedDisplayNameTaken('document', staying, {
        from: 'month/x',
        to: 'week/x',
        name: 'q3 planning',
      }),
    ).toBe('Q3 Planning')
    expect(movedDisplayNameTaken('document', staying, { from: 'month/x', to: 'week/NOTES' })).toBe(
      'notes',
    )
  })

  it('is no duplicate when the entry keeps the label it showed in the same folder', () => {
    expect(
      movedDisplayNameTaken('document', staying, {
        from: 'week/a',
        to: 'week/b',
        name: 'Q3 planning',
      }),
    ).toBeUndefined()
  })
})

describe('shownName', () => {
  it('shows the name somebody gave, trimmed', () => {
    expect(shownName('document', { path: 'class/plan', name: 'Weekly plan' })).toBe('Weekly plan')
    expect(shownName('document', { path: 'class/plan', name: ' Weekly plan ' })).toBe('Weekly plan')
    expect(shownName('document', { path: 'untitled-3', name: 'untitled' })).toBe('untitled')
  })

  it('shows the last segment of an unnamed entry', () => {
    expect(shownName('document', { path: 'class/plan' })).toBe('plan')
    expect(shownName('document', { path: 'plan', name: undefined })).toBe('plan')
    expect(shownName('document', { path: 'notes/roadmap', name: null })).toBe('roadmap')
  })

  it('shows the last segment of an entry whose name is blank', () => {
    expect(shownName('document', { path: 'class/plan', name: '' })).toBe('plan')
    expect(shownName('document', { path: 'class/plan', name: '   ' })).toBe('plan')
  })

  it('shows an unnamed generated address as Untitled, numbered as the address is', () => {
    expect(shownName('document', { path: 'notes/untitled' })).toBe('Untitled')
    expect(shownName('document', { path: 'untitled-3', name: ' ' })).toBe('Untitled 3')
    expect(shownName('document', { path: 'untitled-1' })).toBe('untitled-1')
  })

  it('shows an unnamed folder by its segment, whatever the segment says', () => {
    expect(shownName('folder', { path: 'class/untitled-3' })).toBe('untitled-3')
    expect(shownName('folder', { path: 'class/untitled-3', name: ' Week 3 ' })).toBe('Week 3')
  })

  it('makes a blank-named sibling refuse its own segment as a name', () => {
    const others = [{ path: 'class/plan', name: ' ' }]
    expect(siblingDisplayNameTaken('document', others, { path: 'class/other', name: 'Plan' })).toBe(
      'plan',
    )
    expect(
      siblingDisplayNameTaken('document', others, { path: 'class/other', name: ' ' }),
    ).toBeUndefined()
  })

  it('makes an unnamed generated sibling refuse the label it shows', () => {
    const others = [{ path: 'class/untitled-3' }]
    expect(
      siblingDisplayNameTaken('document', others, { path: 'class/x', name: 'untitled 3' }),
    ).toBe('Untitled 3')
    expect(
      siblingDisplayNameTaken('document', others, { path: 'class/x', name: 'Untitled' }),
    ).toBeUndefined()
  })

  it('reads a blank-named moving entry as showing its segment', () => {
    const staying = [{ path: 'b/plan', name: 'x' }, { path: 'b/other' }]
    expect(
      movedDisplayNameTaken('document', staying, { from: 'a/other', to: 'b/moved', name: '' }),
    ).toBe(undefined)
    expect(
      movedDisplayNameTaken('document', staying, { from: 'a/plan', to: 'b/other-2', name: '' }),
    ).toBeUndefined()
    expect(movedDisplayNameTaken('document', staying, { from: 'a/x', to: 'b/x', name: '' })).toBe(
      'x',
    )
  })
})

describe('firstDistinctUnnamedPath', () => {
  const free = () => false

  it('moves an unnamed document off the label a named sibling shows', () => {
    const siblings = [{ path: 'notes/plan-doc', name: 'Untitled' }]
    expect(firstDistinctUnnamedPath('notes/untitled', siblings, free)).toBe('notes/untitled-2')
  })

  it('keeps a generated address beside unnamed generated siblings, which read apart', () => {
    const siblings = [{ path: 'notes/untitled' }, { path: 'notes/untitled-2' }]
    expect(firstDistinctUnnamedPath('notes/untitled-3', siblings, free)).toBe('notes/untitled-3')
  })
})
