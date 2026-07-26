import { describe, expect, it } from 'vitest'
import { workspaceMetaSchema, workspaceTreeNodeDataSchema } from './workspace-tree.js'

describe('workspaceTreeNodeDataSchema', () => {
  it('accepts a valid canvasId and segment', () => {
    expect(
      workspaceTreeNodeDataSchema.safeParse({
        canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        segment: 'architecture',
      }).success,
    ).toBe(true)
  })

  it('rejects a segment containing a slash', () => {
    expect(
      workspaceTreeNodeDataSchema.safeParse({
        canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        segment: 'a/b',
      }).success,
    ).toBe(false)
  })

  it('rejects "." and ".." traversal segments', () => {
    expect(
      workspaceTreeNodeDataSchema.safeParse({
        canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        segment: '.',
      }).success,
    ).toBe(false)
    expect(
      workspaceTreeNodeDataSchema.safeParse({
        canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        segment: '..',
      }).success,
    ).toBe(false)
  })

  it('rejects an empty segment', () => {
    expect(
      workspaceTreeNodeDataSchema.safeParse({ canvasId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', segment: '' })
        .success,
    ).toBe(false)
  })

  it('rejects a malformed canvasId', () => {
    expect(
      workspaceTreeNodeDataSchema.safeParse({ canvasId: 'not-a-ulid', segment: 'a' }).success,
    ).toBe(false)
  })
})

describe('workspaceMetaSchema', () => {
  it('accepts an empty object', () => {
    expect(workspaceMetaSchema.safeParse({}).success).toBe(true)
  })

  it('accepts arbitrary entries (no required keys by design — kept authz-free)', () => {
    expect(
      workspaceMetaSchema.safeParse({ label: 'My Workspace', anything: [1, 2, 3] }).success,
    ).toBe(true)
  })
})
