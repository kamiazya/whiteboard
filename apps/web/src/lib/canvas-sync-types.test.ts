import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  CANVAS_SYNC_DOC_CHANGED_EVENT,
  CANVAS_SYNC_VERSION_SAVED_EVENT,
  dispatchIdentityEvent,
  type UseCanvasSyncOptions,
} from './canvas-sync-types.js'

describe('canvas-sync event name constants', () => {
  // Pinned literal values: other modules (useDirtyState, HeaderBranchBanner,
  // useBranches, merge-committed-event) still match on the raw string and are
  // out of this slice's scope, so a rename here must not change the wire value.
  it('keeps the doc_changed event name unchanged', () => {
    expect(CANVAS_SYNC_DOC_CHANGED_EVENT).toBe('excalidraw:doc_changed')
  })

  it('keeps the wb_version_saved event name unchanged', () => {
    expect(CANVAS_SYNC_VERSION_SAVED_EVENT).toBe('excalidraw:wb_version_saved')
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

  it('drops the file-upload callbacks from UseCanvasSyncOptions', () => {
    // File uploads had no analog left once the files cache was dropped from
    // the session (fine-grained Loro writes replaced the whole-document
    // Excalidraw-elements commit that used to carry them).
    expectTypeOf<UseCanvasSyncOptions>().not.toHaveProperty('onFileUploadFailed')
    expectTypeOf<UseCanvasSyncOptions>().not.toHaveProperty('onFileUploadSucceeded')
  })
})
