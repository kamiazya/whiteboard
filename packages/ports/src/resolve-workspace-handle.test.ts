/**
 * The ONE definition of how an incoming address string becomes a workspace.
 *
 * ADR-0019 splits one overloaded string into three layers, and the two that
 * can appear in an address — the canonical id and the per-keeper `segment` —
 * share a namespace at every surface that accepts a handle. This helper fixes
 * which one wins, so no route, tool or store can answer differently.
 */
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceHandle, type WorkspaceEntry } from './document-index.js'

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER_ULID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'

describe('resolveWorkspaceHandle', () => {
  it('resolves a segment', () => {
    const entries: WorkspaceEntry[] = [{ workspaceId: ULID, segment: 'design' }]
    expect(resolveWorkspaceHandle(entries, 'design')).toEqual(entries[0])
  })

  it('resolves a canonical id', () => {
    const entries: WorkspaceEntry[] = [{ workspaceId: ULID, segment: 'design' }]
    expect(resolveWorkspaceHandle(entries, ULID)).toEqual(entries[0])
  })

  it('resolves a legacy id that is neither ULID- nor segment-shaped', () => {
    // The daemon's live ids include `default` and nanoid-minted strings with
    // `_`, which `workspaceSegmentSchema` rejects. A handle is never turned
    // away for its SHAPE — only for matching nothing.
    const entries: WorkspaceEntry[] = [{ workspaceId: 'V1StGXR8_Z5jdHi6B-myT' }]
    expect(resolveWorkspaceHandle(entries, 'V1StGXR8_Z5jdHi6B-myT')).toEqual(entries[0])
  })

  it('answers null for a handle that matches nothing', () => {
    const entries: WorkspaceEntry[] = [{ workspaceId: ULID, segment: 'design' }]
    expect(resolveWorkspaceHandle(entries, 'absent')).toBeNull()
    expect(resolveWorkspaceHandle([], ULID)).toBeNull()
  })

  it("segment beats another workspace's id", () => {
    // The collision that decides the order. It cannot arise between a segment
    // and a CANONICAL id — `workspaceSegmentSchema` structurally forbids a
    // ULID-shaped segment — but it can against a legacy id, which is any
    // `[a-zA-Z0-9_-]+` string. Segment wins: it is the layer a human typed on
    // purpose, and the id remains reachable as itself.
    const entries: WorkspaceEntry[] = [
      { workspaceId: OTHER_ULID, segment: 'design' },
      { workspaceId: 'design' },
    ]
    expect(resolveWorkspaceHandle(entries, 'design')).toEqual(entries[0])
    // ...and reversing the list does not change the answer: precedence is by
    // LAYER, not by position.
    expect(resolveWorkspaceHandle([...entries].reverse(), 'design')).toEqual(entries[0])
  })

  it('is the identity over a segmentless registry', () => {
    // Today's daemon, and the Stage-1 no-op this whole increment rests on:
    // with no segment anywhere, resolution can only ever answer the id it was
    // given, so every existing address behaves exactly as before.
    const entries: WorkspaceEntry[] = [{ workspaceId: 'default' }, { workspaceId: ULID }]
    for (const handle of ['default', ULID]) {
      expect(resolveWorkspaceHandle(entries, handle)?.workspaceId).toBe(handle)
    }
  })
})
