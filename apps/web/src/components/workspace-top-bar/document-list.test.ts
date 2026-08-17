import { describe, expect, it } from 'vitest'
import {
  derivePinnedCanvases,
  filterDocumentsBySearch,
  groupCanvases,
  sortDocumentsByRecency,
} from './document-list'
import type { DocumentInfo } from './types'

const canvas = (path: string, updatedAt: string, name?: string): DocumentInfo => ({
  path,
  updatedAt,
  name,
})

describe('sortDocumentsByRecency', () => {
  it('sorts most recently updated first without mutating the input', () => {
    const input = [canvas('a', '2024-01-01'), canvas('b', '2024-02-01'), canvas('c', '2024-01-15')]
    const sorted = sortDocumentsByRecency(input)
    expect(sorted.map((c) => c.path)).toEqual(['b', 'c', 'a'])
    expect(input.map((c) => c.path)).toEqual(['a', 'b', 'c'])
  })
})

describe('filterDocumentsBySearch', () => {
  const canvases = [canvas('team/roadmap', '2024-01-01'), canvas('personal', '2024-01-02')]
  const names: Record<string, string> = { personal: 'My Notes' }

  it('returns every canvas when the query is empty', () => {
    expect(filterDocumentsBySearch(canvases, '', names)).toEqual(canvases)
  })

  it('matches by path case-insensitively', () => {
    expect(filterDocumentsBySearch(canvases, 'ROADMAP', names).map((c) => c.path)).toEqual([
      'team/roadmap',
    ])
  })

  it('matches by custom display name when the path does not match', () => {
    expect(filterDocumentsBySearch(canvases, 'notes', names).map((c) => c.path)).toEqual([
      'personal',
    ])
  })
})

describe('derivePinnedCanvases', () => {
  it('preserves pinned order from names.pinned rather than recency', () => {
    const canvases = [
      canvas('a', '2024-01-01'),
      canvas('b', '2024-01-02'),
      canvas('c', '2024-01-03'),
    ]
    const result = derivePinnedCanvases(canvases, ['c', 'a'])
    expect(result.map((c) => c.path)).toEqual(['c', 'a'])
  })

  it('skips pinned paths that no longer exist in the canvas list', () => {
    const canvases = [canvas('a', '2024-01-01')]
    const result = derivePinnedCanvases(canvases, ['missing', 'a'])
    expect(result.map((c) => c.path)).toEqual(['a'])
  })
})

describe('groupCanvases', () => {
  it('groups by path prefix, sorts headers alphabetically, and keeps ungrouped last', () => {
    const canvases = [
      canvas('zeta/one', '2024-01-01'),
      canvas('alpha/one', '2024-01-02'),
      canvas('solo', '2024-01-03'),
    ]
    const groups = groupCanvases(canvases, new Set())
    expect(groups.map(([group]) => group)).toEqual(['alpha', 'zeta', ''])
  })

  it('excludes canvases already shown in the pinned set', () => {
    const canvases = [canvas('team/a', '2024-01-01'), canvas('team/b', '2024-01-02')]
    const groups = groupCanvases(canvases, new Set(['team/a']))
    expect(groups).toEqual([['team', [canvas('team/b', '2024-01-02')]]])
  })
})
