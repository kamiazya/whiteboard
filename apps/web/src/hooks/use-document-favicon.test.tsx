// @vitest-environment jsdom

/**
 * The shared tab-identity wiring, covered ONCE for both pages — the browser
 * page previously had no favicon coverage at all (the daemon page's suite
 * was the only watcher, and only of its own keeper values).
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserSettingsStore } from '../lib/user-settings-store.js'

const { useFaviconMock, useDocumentOutlineMock } = vi.hoisted(() => ({
  useFaviconMock: vi.fn(),
  useDocumentOutlineMock: vi.fn(() => ['outline-rects']),
}))
vi.mock('./useFavicon.js', () => ({ useFavicon: useFaviconMock }))
vi.mock('./useDocumentOutline.js', () => ({ useDocumentOutline: useDocumentOutlineMock }))

import { useDocumentFavicon } from './use-document-favicon.js'

function settingsWith(faviconStyle?: 'minimap' | 'dot'): UserSettingsStore {
  return {
    load: () => ({ appearance: faviconStyle ? { faviconStyle } : {} }),
  } as unknown as UserSettingsStore
}

describe('useDocumentFavicon', () => {
  beforeEach(() => {
    useFaviconMock.mockClear()
    useDocumentOutlineMock.mockClear()
  })

  it('wires the settings style, the keeper status, and the outline into useFavicon', () => {
    renderHook(() =>
      useDocumentFavicon({
        settingsStore: settingsWith('dot'),
        documentId: 'doc-1',
        kind: 'spatial',
        revision: 'r1',
        readSource: () => null,
        status: 'syncing',
      }),
    )
    expect(useFaviconMock).toHaveBeenCalledWith({
      style: 'dot',
      status: 'syncing',
      rects: ['outline-rects'],
    })
    expect(useDocumentOutlineMock).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc-1', kind: 'spatial', revision: 'r1' }),
    )
  })

  it('defaults the style to minimap when settings carry none', () => {
    renderHook(() =>
      useDocumentFavicon({
        settingsStore: settingsWith(),
        documentId: null,
        kind: 'markdown',
        revision: null,
        readSource: () => null,
        status: 'quiet',
      }),
    )
    expect(useFaviconMock).toHaveBeenCalledWith(expect.objectContaining({ style: 'minimap' }))
  })

  it('keeps one broker across re-renders — the outline cache must not be reminted', () => {
    const props = {
      settingsStore: settingsWith(),
      documentId: 'doc-1',
      kind: 'spatial' as const,
      revision: 'r1' as unknown,
      readSource: () => null,
      status: 'quiet' as const,
    }
    const { rerender } = renderHook((p: typeof props) => useDocumentFavicon(p), {
      initialProps: props,
    })
    rerender({ ...props, revision: 'r2' })
    const brokers = useDocumentOutlineMock.mock.calls.map(
      (call) => (call as unknown as [{ broker: unknown }])[0].broker,
    )
    expect(brokers.length).toBeGreaterThan(1)
    expect(new Set(brokers).size).toBe(1)
  })
})
