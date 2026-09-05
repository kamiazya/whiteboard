// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { fc, fcTest, withDefaults } from '../../test-utils/fast-check.js'
import { isGeneratedDocumentPath, newDocumentPathIn } from './new-document-path.js'

describe('newDocumentPathIn', () => {
  it('creates in the folder the browser is standing in', () => {
    expect(newDocumentPathIn('design/notes', [])).toBe('design/notes/untitled')
  })

  it('creates at the top level when that is where you are', () => {
    expect(newDocumentPathIn('', [])).toBe('untitled')
  })

  // Numbering is per folder: `design/untitled` does not make the next
  // document at the root `untitled-2`, because they do not collide.
  it('numbers within the folder, not across the workspace', () => {
    const taken = ['untitled', 'design/untitled', 'design/untitled-2']
    expect(newDocumentPathIn('design', taken)).toBe('design/untitled-3')
    expect(newDocumentPathIn('inbox', taken)).toBe('inbox/untitled')
  })

  it('skips the numbers already taken here', () => {
    expect(newDocumentPathIn('', ['untitled', 'untitled-2', 'untitled-4'])).toBe('untitled-3')
  })

  // A folder deeper down is not a sibling: `design/notes/untitled` must not
  // make `design/untitled` look taken.
  it('ignores what lives further down', () => {
    expect(newDocumentPathIn('design', ['design/notes/untitled'])).toBe('design/untitled')
  })

  // The prefix is anchored at a segment boundary, the same rule the contents
  // pane uses. The fixture is chosen so an unanchored slice would produce
  // exactly `untitled`: 'design-untitled' cut at the length of 'design/'
  // leaves 'untitled', and a near-miss like 'design-system/untitled' would
  // leave 'system/untitled' and pass whether the rule is there or not.
  it('anchors the folder at a segment boundary', () => {
    expect(newDocumentPathIn('design', ['design-untitled'])).toBe('design/untitled')
    expect(newDocumentPathIn('design', ['design-system/untitled'])).toBe('design/untitled')
  })
})

describe('isGeneratedDocumentPath', () => {
  it('recognises what newDocumentPathIn produces, at the root and in a folder', () => {
    expect(isGeneratedDocumentPath('untitled')).toBe(true)
    expect(isGeneratedDocumentPath('untitled-2')).toBe(true)
    expect(isGeneratedDocumentPath('design/untitled-17')).toBe(true)
  })

  it('does not claim a path a person chose', () => {
    expect(isGeneratedDocumentPath('weekly-review')).toBe(false)
    expect(isGeneratedDocumentPath('untitled-notes')).toBe(false)
    expect(isGeneratedDocumentPath('design/untitled/child')).toBe(false)
    // `-1` and `-0` are never generated: the counter starts at 2.
    expect(isGeneratedDocumentPath('untitled-1')).toBe(false)
  })

  // The pair has to agree, or the seeding gate opens on paths nobody generated.
  fcTest.prop([fc.integer({ min: 0, max: 30 })], withDefaults())(
    'every path the generator produces is recognised by the predicate',
    (howMany) => {
      const taken: string[] = []
      for (let i = 0; i < howMany; i++) taken.push(newDocumentPathIn('design', taken))
      for (const path of taken) expect(isGeneratedDocumentPath(path)).toBe(true)
    },
  )
})
