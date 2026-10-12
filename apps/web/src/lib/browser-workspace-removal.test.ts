import { describe, expect, it } from 'vitest'
import { canDemote } from './browser-workspace-removal.js'
import type { PromoteWorkspaceResult } from './promote-workspace.js'

type PromotedOutcome = Extract<PromoteWorkspaceResult, { kind: 'ok' }>

function outcome(overrides: Partial<PromotedOutcome> = {}): PromotedOutcome {
  return {
    kind: 'ok',
    sourceWorkspaceId: 'browser-ws',
    promotedDocumentIds: ['d1'],
    shadowedPaths: [],
    blobs: { transferred: [], missing: [], failed: [] },
    leftBehind: [],
    ...overrides,
  } as PromotedOutcome
}

describe('canDemote', () => {
  it('allows a move that left nothing behind', () => {
    expect(canDemote(outcome())).toBe(true)
  })

  it('allows one whose images all transferred', () => {
    expect(canDemote(outcome({ blobs: { transferred: ['f1'], missing: [], failed: [] } }))).toBe(
      true,
    )
  })

  it.each<[string, Partial<PromotedOutcome>]>([
    [
      'an image failed to move',
      { blobs: { transferred: [], missing: [], failed: [{ fileId: 'f1', reason: 'too big' }] } },
    ],
    ['an image read as missing', { blobs: { transferred: [], missing: ['f1'], failed: [] } }],
    ['the daemon did not confirm a carried plane', { leftBehind: ['a trash entry'] }],
  ])('refuses when %s', (_why, overrides) => {
    expect(canDemote(outcome(overrides))).toBe(false)
  })
})
