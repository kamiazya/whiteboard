import { describe, expect, it } from 'vitest'
import {
  BranchConflictError,
  BranchNotFoundError,
  createBranch,
  deleteBranch,
  nextBranchColor,
  renameBranch,
  setHead,
  updateBranchTip,
} from './ops.js'
import { type DocumentBranchesState, defaultMain, resolveHead } from './schema.js'

const scope = { workspaceId: 'w1', path: 'notes/a' }
const at = new Date('2026-01-02T03:04:05.000Z')

function withIdea(): DocumentBranchesState {
  const start = { branches: [defaultMain(at)], head: 'main' }
  return createBranch(start, scope, { name: 'idea', now: at }).next as DocumentBranchesState
}

describe('branch operations', () => {
  it('creates a branch beside main without moving HEAD, wearing the first free palette colour', () => {
    const { next, result } = createBranch({ branches: [defaultMain(at)], head: 'main' }, scope, {
      name: 'idea',
      baseBranch: 'main',
      now: at,
    })
    expect(result).toEqual({
      name: 'idea',
      tipFrontiers: '',
      color: nextBranchColor([defaultMain(at)]),
      createdAt: at.toISOString(),
      baseBranch: 'main',
    })
    expect(next?.head).toBe('main')
    expect(next?.branches.map((b) => b.name)).toEqual(['main', 'idea'])
  })

  it('refuses a duplicate name', () => {
    expect(() => createBranch(withIdea(), scope, { name: 'idea' })).toThrow(BranchConflictError)
  })

  it('cycles the palette once every colour is worn', () => {
    let state: DocumentBranchesState = { branches: [defaultMain(at)], head: 'main' }
    for (let i = 0; i < 8; i++) {
      state = createBranch(state, scope, { name: `b${i}` }).next as DocumentBranchesState
    }
    const colours = state.branches.slice(1).map((b) => b.color)
    expect(new Set(colours.slice(0, 6)).size).toBe(6)
    expect(colours[6]).toBeDefined()
  })

  it('switches HEAD, answers the head it left, and writes nothing for a no-op switch', () => {
    const switched = setHead(withIdea(), scope, 'idea')
    expect(switched.result).toEqual({ head: 'idea', previousHead: 'main' })
    expect(switched.next?.head).toBe('idea')
    const again = setHead(switched.next as DocumentBranchesState, scope, 'idea')
    expect(again.next).toBeNull()
    expect(again.result).toEqual({ head: 'idea', previousHead: 'idea' })
    expect(() => setHead(withIdea(), scope, 'ghost')).toThrow(BranchNotFoundError)
  })

  it('never deletes main or HEAD, and drops any other branch', () => {
    expect(() => deleteBranch(withIdea(), scope, 'main')).toThrow(BranchConflictError)
    const onIdea = setHead(withIdea(), scope, 'idea').next as DocumentBranchesState
    expect(() => deleteBranch(onIdea, scope, 'idea')).toThrow(BranchConflictError)
    expect(() => deleteBranch(withIdea(), scope, 'ghost')).toThrow(BranchNotFoundError)
    const { next, result } = deleteBranch(withIdea(), scope, 'idea')
    expect(result).toEqual({ ok: true, unmergedCommits: 0 })
    expect(next?.branches.map((b) => b.name)).toEqual(['main'])
  })

  it('renames in place, carrying HEAD and every baseBranch that named the old name', () => {
    let state = setHead(withIdea(), scope, 'idea').next as DocumentBranchesState
    state = createBranch(state, scope, { name: 'child', baseBranch: 'idea', now: at })
      .next as DocumentBranchesState
    const { next, result } = renameBranch(state, scope, 'idea', 'plan')
    expect(result.name).toBe('plan')
    expect(next?.head).toBe('plan')
    expect(next?.branches.find((b) => b.name === 'child')?.baseBranch).toBe('plan')
    expect(next?.branches.map((b) => b.name)).toEqual(['main', 'plan', 'child'])
    expect(() => renameBranch(state, scope, 'main', 'trunk')).toThrow(BranchConflictError)
    expect(() => renameBranch(state, scope, 'idea', 'child')).toThrow(BranchConflictError)
    expect(renameBranch(state, scope, 'idea', 'idea').next).toBeNull()
  })

  it('moves a tip, and writes nothing when the tip is already there', () => {
    const moved = updateBranchTip(withIdea(), scope, 'idea', 'AAEC')
    expect(moved.next?.branches.find((b) => b.name === 'idea')?.tipFrontiers).toBe('AAEC')
    expect(
      updateBranchTip(moved.next as DocumentBranchesState, scope, 'idea', 'AAEC').next,
    ).toBeNull()
    expect(() => updateBranchTip(withIdea(), scope, 'ghost', 'x')).toThrow(BranchNotFoundError)
  })

  it('resolves a stored HEAD over the branches actually held', () => {
    const branches = withIdea().branches
    expect(resolveHead(branches, 'idea')).toBe('idea')
    expect(resolveHead(branches, 'gone')).toBe('main')
    expect(resolveHead(branches, undefined)).toBe('main')
    expect(
      resolveHead(
        branches.filter((b) => b.name !== 'main'),
        'gone',
      ),
    ).toBe('idea')
    expect(resolveHead([], 'gone')).toBe('main')
  })
})
