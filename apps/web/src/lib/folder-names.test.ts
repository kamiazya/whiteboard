// @vitest-environment node
import { documentPathSchema } from '@kamiazya/whiteboard-model'
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../test-utils/fast-check.js'
import {
  folderDisplayName,
  folderTrail,
  isFolderNameTaken,
  newFolderSegmentIn,
  planNestedFolder,
} from './folder-names.js'

const names = new Map([
  ['class', 'Class'],
  ['class/week-6', 'Week 6'],
])

describe('what a folder is called', () => {
  it('shows the name it was given, and its segment when it has none', () => {
    expect(folderDisplayName('class/week-6', names)).toBe('Week 6')
    expect(folderDisplayName('class/drafts', names)).toBe('drafts')
    expect(folderDisplayName('', names)).toBe('Workspace')
  })

  it('names every folder on the way down', () => {
    expect(folderTrail('class/week-6/notes', names)).toEqual(['Class', 'Week 6', 'notes'])
    expect(folderTrail('', names)).toEqual([])
  })
})

describe('the address a new folder gets', () => {
  it('is derived from the name under its parent', () => {
    expect(newFolderSegmentIn('class', 'Week 6', [])).toBe('class/week-6')
    expect(newFolderSegmentIn('', 'Week 6', [])).toBe('week-6')
  })

  it('falls back to folder for a name the address charset cannot spell', () => {
    expect(newFolderSegmentIn('', '第六週', [])).toBe('folder')
  })

  it('numbers past a sibling folder or document that holds the address', () => {
    expect(newFolderSegmentIn('class', 'Week 6', ['class/week-6/a', 'class/week-6-2'])).toBe(
      'class/week-6-3',
    )
    // A same-named segment elsewhere is no collision.
    expect(newFolderSegmentIn('class', 'Week 6', ['other/week-6/a'])).toBe('class/week-6')
  })
})

describe('a duplicate folder name', () => {
  const folders = ['class', 'class/week-6', 'class/drafts', 'other']

  it('is a name a sibling folder already shows, compared trimmed and case-folded', () => {
    expect(isFolderNameTaken(folders, names, { path: 'class/drafts', name: ' week 6 ' })).toBe(true)
    expect(isFolderNameTaken(folders, names, { path: 'class/drafts', name: 'Drafts' })).toBe(false)
  })

  it('is no duplicate of the folder itself, nor of a folder under another parent', () => {
    expect(isFolderNameTaken(folders, names, { path: 'class/week-6', name: 'week 6' })).toBe(false)
    expect(isFolderNameTaken(folders, names, { path: 'other', name: 'Week 6' })).toBe(false)
  })
})

// A dense alphabet, so siblings collide with the derived address often.
const segmentArb = fc.constantFrom('a', 'b', 'week-6', 'week-6-2', 'folder', 'folder-2')
const pathArb = fc
  .array(segmentArb, { minLength: 1, maxLength: 3 })
  .map((segments) => segments.join('/'))
const parentArb = fc.constantFrom('', 'a', 'a/b')
const nameArb = fc.constantFrom('Week 6', 'week 6', 'A', '第六週', '!!!', 'Folder')

describe('newFolderSegmentIn (fast-check)', () => {
  fcTest.prop([parentArb, nameArb, fc.array(pathArb, { maxLength: 12 })], withDefaults())(
    'answers a well-formed path directly under the parent that nothing taken holds',
    (parent, name, taken) => {
      const path = newFolderSegmentIn(parent, name, taken)
      expect(documentPathSchema.safeParse(path).success).toBe(true)
      const cut = path.lastIndexOf('/')
      expect(cut === -1 ? '' : path.slice(0, cut)).toBe(parent)
      expect(taken).not.toContain(path)
      expect(taken.some((each) => each.startsWith(`${path}/`))).toBe(false)
    },
  )
})

describe('a typed new folder', () => {
  const known = {
    folders: ['class', 'class/week-6', 'other'],
    names,
    taken: ['class/week-6/notes', 'other/a'],
  }

  it('nests at each "/", naming every folder it makes by its part', () => {
    expect(planNestedFolder('Term 2/Week 1', known)).toEqual({
      path: 'term-2/week-1',
      created: [
        { path: 'term-2', name: 'Term 2' },
        { path: 'term-2/week-1', name: 'Week 1' },
      ],
    })
  })

  it('goes through a folder already called by a part, and makes only the rest', () => {
    expect(planNestedFolder(' class / Week 7 ', known)).toEqual({
      path: 'class/week-7',
      created: [{ path: 'class/week-7', name: 'Week 7' }],
    })
  })

  it('refuses a last part a sibling folder already shows', () => {
    expect(planNestedFolder('Class/week 6', known)).toEqual({
      refusal:
        'Another folder in this folder is already called "week 6". Choose a name no other folder beside it has.',
    })
  })

  it('refuses a blank name', () => {
    expect(planNestedFolder(' / ', known)).toEqual({ refusal: 'A folder name cannot be blank.' })
  })
})
