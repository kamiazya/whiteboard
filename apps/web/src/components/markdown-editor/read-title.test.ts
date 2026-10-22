import { describe, expect, it } from 'vitest'
import { shownBody } from './read-title.js'

const withoutTitleHeading = (body: string, title: string | undefined) =>
  shownBody(body, 'read', true, title)

describe('shownBody in Read mode', () => {
  it('blanks a leading H1 that repeats the document name, keeping every offset', () => {
    const body = '# Weekly sync\n\nnotes'
    const shown = withoutTitleHeading(body, 'Weekly sync')
    expect(shown).toHaveLength(body.length)
    expect(shown.trim()).toBe('notes')
  })

  it('compares case-insensitively and ignoring surrounding space', () => {
    expect(withoutTitleHeading('#   weekly SYNC  \nbody', '  Weekly Sync ').trim()).toBe('body')
  })

  it('skips blank lines before the heading', () => {
    expect(withoutTitleHeading('\n\n# Plan\nbody', 'Plan').trim()).toBe('body')
  })

  it('leaves a different H1, a deeper heading and a later H1 alone', () => {
    expect(withoutTitleHeading('# Other\nbody', 'Plan')).toBe('# Other\nbody')
    expect(withoutTitleHeading('## Plan\nbody', 'Plan')).toBe('## Plan\nbody')
    expect(withoutTitleHeading('intro\n# Plan', 'Plan')).toBe('intro\n# Plan')
  })

  it('leaves the body alone without a title', () => {
    expect(withoutTitleHeading('# Plan', undefined)).toBe('# Plan')
    expect(withoutTitleHeading('# Plan', '')).toBe('# Plan')
  })

  it('shows the body untouched outside Read mode or without a header', () => {
    expect(shownBody('# Plan', 'split', true, 'Plan')).toBe('# Plan')
    expect(shownBody('# Plan', 'read', false, 'Plan')).toBe('# Plan')
  })
})
