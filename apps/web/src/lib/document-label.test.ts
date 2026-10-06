import { describe, expect, it } from 'vitest'
import { documentLabel } from './document-label.js'

describe('documentLabel', () => {
  it('answers a chosen name under either rule', () => {
    const entry = { name: 'Sprint plan', path: 'team/plans/q3' }
    expect(documentLabel(entry, 'leaf')).toBe('Sprint plan')
    expect(documentLabel(entry, 'path')).toBe('Sprint plan')
  })

  it('answers the last path segment for an unnamed document under the leaf rule', () => {
    expect(documentLabel({ name: null, path: 'team/plans/q3' }, 'leaf')).toBe('q3')
    expect(documentLabel({ path: 'team/plans/q3' }, 'leaf')).toBe('q3')
  })

  it('answers the whole path for an unnamed document under the path rule', () => {
    expect(documentLabel({ name: null, path: 'team/plans/q3' }, 'path')).toBe('team/plans/q3')
    expect(documentLabel({ path: 'team/plans/q3' }, 'path')).toBe('team/plans/q3')
  })

  it('keeps a chosen name that happens to equal the path', () => {
    // Unnamed is spelled by absence, never by comparing against the address.
    expect(documentLabel({ name: 'untitled', path: 'untitled' }, 'leaf')).toBe('untitled')
    expect(documentLabel({ name: 'a/b', path: 'a/b' }, 'leaf')).toBe('a/b')
  })

  it('answers a root-level path whole under the leaf rule', () => {
    expect(documentLabel({ name: null, path: 'untitled-2' }, 'leaf')).toBe('untitled-2')
  })
})
