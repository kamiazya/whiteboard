// @vitest-environment jsdom

import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DOCUMENT_SYNC_VERSION_SAVED_EVENT } from '../lib/document-sync-types.js'
import { useIdentityEvent } from './use-identity-event.js'

function announce(workspaceId: string, path: string): void {
  window.dispatchEvent(
    new CustomEvent(DOCUMENT_SYNC_VERSION_SAVED_EVENT, { detail: { workspaceId, path } }),
  )
}

describe('useIdentityEvent', () => {
  it('delivers only announcements addressed to this document', () => {
    const handler = vi.fn()
    renderHook(() => useIdentityEvent(DOCUMENT_SYNC_VERSION_SAVED_EVENT, 'local', 'here', handler))

    act(() => announce('local', 'some-other-doc'))
    expect(handler, "another document's announcement must not be delivered").not.toHaveBeenCalled()
    act(() => announce('daemon-ws', 'here'))
    expect(
      handler,
      'a matching path in another workspace is another document',
    ).not.toHaveBeenCalled()
    act(() => window.dispatchEvent(new CustomEvent(DOCUMENT_SYNC_VERSION_SAVED_EVENT)))
    expect(handler, 'a detail-less event addresses nobody').not.toHaveBeenCalled()

    act(() => announce('local', 'here'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('subscribes to nothing while the page has no document', () => {
    const handler = vi.fn()
    renderHook(() => useIdentityEvent(DOCUMENT_SYNC_VERSION_SAVED_EVENT, 'local', null, handler))
    act(() => announce('local', 'here'))
    expect(handler).not.toHaveBeenCalled()
  })

  it('follows a document switch: the old identity stops delivering, the new one starts', () => {
    const handler = vi.fn()
    const { rerender } = renderHook(
      ({ path }: { path: string }) =>
        useIdentityEvent(DOCUMENT_SYNC_VERSION_SAVED_EVENT, 'local', path, handler),
      { initialProps: { path: 'here' } },
    )
    rerender({ path: 'there' })
    act(() => announce('local', 'here'))
    expect(handler, 'the departed document must stop delivering').not.toHaveBeenCalled()
    act(() => announce('local', 'there'))
    expect(handler).toHaveBeenCalledTimes(1)
  })
})
