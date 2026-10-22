import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWorkspaceDocs } from './browser-workspace-docs.js'
import { demoteWhenSafe } from './browser-workspace-removal.js'
import { demoteBrowserWorkspace, replicaCarriesAll } from './demote-browser-workspace.js'
import type { PromoteWorkspaceResult } from './promote-workspace.js'

vi.mock('./demote-browser-workspace.js', () => ({
  demoteBrowserWorkspace: vi.fn(async () => {}),
  replicaCarriesAll: vi.fn(async () => true),
}))

type PromotedOutcome = Extract<PromoteWorkspaceResult, { kind: 'ok' }>

/** Never read: the replica read-back is mocked above. */
const DOCS = {} as BrowserWorkspaceDocs

function outcome(overrides: Partial<PromotedOutcome> = {}): PromotedOutcome {
  return {
    kind: 'ok',
    sourceWorkspaceId: 'browser-ws',
    promotedDocumentIds: ['d1'],
    shadowedPaths: [],
    blobs: { transferred: [], missing: [], failed: [] },
    leftBehind: [],
    versionsLeftBehind: 0,
    ...overrides,
  }
}

describe('demoteWhenSafe', () => {
  beforeEach(() => {
    vi.mocked(demoteBrowserWorkspace).mockClear()
    vi.mocked(replicaCarriesAll).mockResolvedValue(true)
  })

  it('deletes the browser copy of a move that left nothing behind', async () => {
    const moved = outcome({ blobs: { transferred: ['f1'], missing: [], failed: [] } })
    expect(await demoteWhenSafe(DOCS, 'ws-daemon', moved)).toBe(true)
    expect(replicaCarriesAll).toHaveBeenCalledWith(DOCS, 'ws-daemon', ['d1'])
    expect(demoteBrowserWorkspace).toHaveBeenCalledWith('browser-ws')
  })

  it.each<[string, Partial<PromotedOutcome>]>([
    [
      'an image failed to move',
      { blobs: { transferred: [], missing: [], failed: [{ fileId: 'f1', reason: 'too big' }] } },
    ],
    ['an image read as missing', { blobs: { transferred: [], missing: ['f1'], failed: [] } }],
    ['the daemon did not confirm a carried plane', { leftBehind: ['a trash entry'] }],
    // Counted apart from the sentences, so dropped versions keep the copy even unnamed.
    ['saved versions stayed behind', { versionsLeftBehind: 1 }],
  ])('keeps it when %s', async (_why, overrides) => {
    expect(await demoteWhenSafe(DOCS, 'ws-daemon', outcome(overrides))).toBe(false)
    expect(demoteBrowserWorkspace).not.toHaveBeenCalled()
  })

  it('keeps it when the stored replica does not carry every promoted document', async () => {
    vi.mocked(replicaCarriesAll).mockResolvedValue(false)
    expect(await demoteWhenSafe(DOCS, 'ws-daemon', outcome())).toBe(false)
    expect(demoteBrowserWorkspace).not.toHaveBeenCalled()
  })
})
