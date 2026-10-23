import { describe, expect, it } from 'vitest'
import type { LinkTarget } from '../../lib/link-target.js'
import { referenceAtOffset } from './wiki-link-follow.js'

const TARGETS: readonly LinkTarget[] = [
  { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', path: 'release-plan', name: 'Release plan' },
  { id: '01BX5ZZKBKACTAV9WEVGEMMVRZ', path: 'retro', name: 'Retro' },
]

describe('referenceAtOffset', () => {
  it('resolves a link by path to its document', () => {
    const doc = 'see [[release-plan]] now'
    expect(referenceAtOffset(doc, 8, TARGETS)).toMatchObject({
      kind: 'resolved',
      target: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    })
  })

  it('resolves the alias form by its path half and an id form by id', () => {
    expect(referenceAtOffset('[[retro|Last week]]', 3, TARGETS)).toMatchObject({
      kind: 'resolved',
      target: { path: 'retro' },
    })
    expect(referenceAtOffset('[[01ARZ3NDEKTSV4RRFFQ69G5FAV]]', 3, TARGETS)).toMatchObject({
      kind: 'resolved',
      target: { path: 'release-plan' },
    })
  })

  it('answers unresolved with the written path, never matching a display name', () => {
    expect(referenceAtOffset('a [[Release plan]]', 6, TARGETS)).toEqual({
      kind: 'unresolved',
      path: 'Release plan',
      alias: undefined,
      index: 2,
      length: 16,
    })
  })

  it('covers the whole reference including its brackets and an embed bang', () => {
    const doc = 'a ![[retro]] b'
    expect(referenceAtOffset(doc, 2, TARGETS)?.kind).toBe('resolved')
    expect(referenceAtOffset(doc, 12, TARGETS)?.kind).toBe('resolved')
    expect(referenceAtOffset(doc, 1, TARGETS)).toBeNull()
    expect(referenceAtOffset(doc, 13, TARGETS)).toBeNull()
  })

  it('answers null outside any reference', () => {
    expect(referenceAtOffset('plain [x] text', 3, TARGETS)).toBeNull()
  })
})
