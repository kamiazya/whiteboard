import { describe, expect, it } from 'vitest'
import { newDocumentPathIn } from './new-document-path.js'

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
