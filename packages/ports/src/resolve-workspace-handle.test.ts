/**
 * The ONE definition of how an incoming address string becomes a workspace.
 *
 * ADR-0019 splits one overloaded string into three layers, and the two that
 * can appear in an address — the canonical id and the per-keeper `segment` —
 * share a namespace at every surface that accepts a handle. This helper fixes
 * which one wins, so no route, tool or store can answer differently.
 */
import { formatWorkspaceAddress } from '@kamiazya/whiteboard-model'
import { canonicalUlidArbitrary } from '@kamiazya/whiteboard-model/test-utils'
import { describe, expect, it } from 'vitest'
import { resolveWorkspaceHandle, type WorkspaceEntry } from './document-index.js'
import { fc, fcTest, withDefaults } from './test-utils/fast-check.js'

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

  describe('the three address forms', () => {
    const entries: WorkspaceEntry[] = [
      { workspaceId: ULID, namespace: 'alice', segment: 'design' },
      { workspaceId: OTHER_ULID, namespace: 'bob', segment: 'design' },
    ]

    it('a qualified handle names the segment inside that namespace only', () => {
      expect(resolveWorkspaceHandle(entries, 'alice/design')).toEqual(entries[0])
      expect(resolveWorkspaceHandle(entries, 'bob/design')).toEqual(entries[1])
      expect(resolveWorkspaceHandle(entries, 'carol/design')).toBeNull()
    })

    it("a bare segment means the caller's own namespace", () => {
      expect(resolveWorkspaceHandle(entries, 'design', 'bob')).toEqual(entries[1])
      expect(resolveWorkspaceHandle(entries, 'design', 'carol')).toBeNull()
    })

    it('fails closed for a caller that names no namespace on a keeper whose rows carry one', () => {
      // The default is the single-person namespace, and a many-person keeper's
      // rows never sit in it, so a call site that forgot the caller reaches
      // nothing rather than somebody else's segment.
      expect(resolveWorkspaceHandle(entries, 'design')).toBeNull()
    })

    it('a row with no namespace sits in the single-person one, `me`', () => {
      const mine: WorkspaceEntry[] = [{ workspaceId: ULID, segment: 'design' }]
      expect(resolveWorkspaceHandle(mine, 'me/design')).toEqual(mine[0])
      expect(resolveWorkspaceHandle(mine, 'design')).toEqual(mine[0])
      expect(resolveWorkspaceHandle(mine, 'alice/design')).toBeNull()
    })

    it('the canonical id reaches a workspace in any namespace', () => {
      expect(resolveWorkspaceHandle(entries, OTHER_ULID, 'alice')).toEqual(entries[1])
    })

    it('an address that spells no form matches nothing', () => {
      expect(resolveWorkspaceHandle(entries, 'alice/design/x')).toBeNull()
      expect(resolveWorkspaceHandle(entries, `${ULID}/design`)).toBeNull()
    })
  })

  /**
   * A registry dense on the collision this resolution exists for: few
   * namespaces and few segments, so the same segment sits in several
   * namespaces in most draws. Unique per (namespace, segment) and per id, as
   * the registry enforces.
   */
  const registryArb = fc
    .uniqueArray(
      fc.record({
        workspaceId: canonicalUlidArbitrary,
        namespace: fc.constantFrom('me', 'alice', 'bob'),
        segment: fc.constantFrom('design', 'plan', 'notes'),
      }),
      {
        minLength: 1,
        maxLength: 9,
        selector: (entry) => `${entry.namespace}/${entry.segment}`,
      },
    )
    .filter((entries) => new Set(entries.map((e) => e.workspaceId)).size === entries.length)

  fcTest.prop([registryArb], withDefaults())(
    'every form of every entry resolves to that entry and no other',
    (entries) => {
      for (const entry of entries) {
        const { workspaceId, namespace, segment } = entry
        const forms = [
          formatWorkspaceAddress({ form: 'id', workspaceId }),
          formatWorkspaceAddress({ form: 'qualified', namespace, segment }),
        ]
        for (const handle of forms) {
          expect(resolveWorkspaceHandle(entries, handle, 'alice')).toEqual(entry)
        }
        const bare = formatWorkspaceAddress({ form: 'bare', handle: segment })
        expect(resolveWorkspaceHandle(entries, bare, namespace)).toEqual(entry)
      }
    },
  )

  fcTest.prop([registryArb, fc.constantFrom('design', 'plan', 'notes', 'absent')], withDefaults())(
    "a bare segment never reaches outside the caller's namespace",
    (entries, segment) => {
      for (const caller of ['me', 'alice', 'bob', 'carol']) {
        const found = resolveWorkspaceHandle(entries, segment, caller)
        expect(found === null || found.namespace === caller).toBe(true)
      }
    },
  )
})
