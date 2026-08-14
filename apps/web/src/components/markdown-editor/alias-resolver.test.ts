import { describe, expect, it } from 'vitest'
import { createSnapshotAliasResolver } from './alias-resolver.js'

const A = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const B = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const C = '01BX5ZZKBKACTAV9WEVGEMMVS0'

describe('createSnapshotAliasResolver', () => {
  it('resolves a unique exact name match to its canvas id', () => {
    const resolve = createSnapshotAliasResolver([
      { id: A, name: 'Release plan' },
      { id: B, name: 'Meeting notes' },
    ])
    expect(resolve('Release plan')).toBe(A)
    expect(resolve('Meeting notes')).toBe(B)
  })

  it('never guesses: an ambiguous name resolves to null', () => {
    const resolve = createSnapshotAliasResolver([
      { id: A, name: 'untitled' },
      { id: B, name: 'untitled' },
      { id: C, name: 'unique' },
    ])
    expect(resolve('untitled')).toBeNull()
    expect(resolve('unique')).toBe(C)
  })

  it('unknown names and empty lists resolve to null', () => {
    expect(createSnapshotAliasResolver([])('anything')).toBeNull()
    expect(createSnapshotAliasResolver([{ id: A, name: 'x' }])('y')).toBeNull()
  })

  it('matches exactly — no case folding or trimming surprises', () => {
    const resolve = createSnapshotAliasResolver([{ id: A, name: 'Notes' }])
    expect(resolve('notes')).toBeNull()
    expect(resolve('Notes ')).toBeNull()
  })
})
