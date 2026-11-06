import { describe, expect, it } from 'vitest'
import { duplicateLanded } from './duplicate-landed.js'

describe('duplicateLanded', () => {
  it('counts a path that arrived beside the source', () => {
    expect(duplicateLanded(new Set(['notes/a']), ['notes/a', 'notes/a-copy'], 'notes/a')).toBe(true)
  })

  it('ignores a listing with nothing new', () => {
    expect(duplicateLanded(new Set(['notes/a']), ['notes/a'], 'notes/a')).toBe(false)
  })

  it('ignores a path that arrived in another folder', () => {
    expect(duplicateLanded(new Set(['notes/a']), ['notes/a', 'a-copy'], 'notes/a')).toBe(false)
  })
})
