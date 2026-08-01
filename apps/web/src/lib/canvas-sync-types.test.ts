import { describe, expect, it, vi } from 'vitest'
import {
  CANVAS_SYNC_DOC_CHANGED_EVENT,
  CANVAS_SYNC_VERSION_SAVED_EVENT,
  dispatchIdentityEvent,
} from './canvas-sync-types.js'

describe('canvas-sync event name constants', () => {
  // Pinned literal values: other modules (useDirtyState, HeaderBranchBanner,
  // useBranches, merge-committed-event) still match on the raw string and are
  // out of this slice's scope, so a rename here must not change the wire value.
  it('keeps the doc_changed event name unchanged', () => {
    expect(CANVAS_SYNC_DOC_CHANGED_EVENT).toBe('excalidraw:doc_changed')
  })

  it('keeps the version_saved event name unchanged', () => {
    expect(CANVAS_SYNC_VERSION_SAVED_EVENT).toBe('excalidraw:version_saved')
  })

  it('dispatchIdentityEvent fires the constant event name it is called with', () => {
    const handler = vi.fn()
    window.addEventListener(CANVAS_SYNC_DOC_CHANGED_EVENT, handler)
    dispatchIdentityEvent(CANVAS_SYNC_DOC_CHANGED_EVENT, {
      workspaceId: 'ws',
      slug: 'slug',
    })
    window.removeEventListener(CANVAS_SYNC_DOC_CHANGED_EVENT, handler)
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
