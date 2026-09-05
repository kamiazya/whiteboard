// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { kindNoun } from './kind-noun.js'

describe('kindNoun', () => {
  it('names each kind, and the honest generic when none is recorded', () => {
    expect(kindNoun('spatial')).toBe('canvas')
    expect(kindNoun('markdown')).toBe('note')
    // Pre-kind documents have no recorded kind; calling one "canvas" is
    // exactly the guess this helper exists to retire.
    expect(kindNoun(undefined)).toBe('document')
  })
})
