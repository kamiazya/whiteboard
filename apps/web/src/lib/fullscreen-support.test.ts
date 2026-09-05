// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { isFullscreenSupported } from './fullscreen-support.js'

function fakeDoc(root: Record<string, unknown> | null, docProps: Record<string, unknown> = {}) {
  return { documentElement: root, ...docProps } as unknown as Document
}

describe('isFullscreenSupported', () => {
  it('is false where the element API is absent (iPhone Safari: video-only)', () => {
    // The device shape that made this function necessary: no
    // requestFullscreen at all, and `fullscreenEnabled` not implemented
    // either — so it reads undefined, not false.
    expect(isFullscreenSupported(fakeDoc({}))).toBe(false)
  })

  it('is true where the element API exists', () => {
    expect(isFullscreenSupported(fakeDoc({ requestFullscreen: () => {} }))).toBe(true)
  })

  it('accepts the legacy prefixed method', () => {
    expect(isFullscreenSupported(fakeDoc({ webkitRequestFullscreen: () => {} }))).toBe(true)
  })

  it('honours an explicit refusal even when the method exists (embedded iframe)', () => {
    expect(
      isFullscreenSupported(fakeDoc({ requestFullscreen: () => {} }, { fullscreenEnabled: false })),
    ).toBe(false)
  })

  it('is false, never a throw, with no document element at all', () => {
    expect(isFullscreenSupported(fakeDoc(null))).toBe(false)
  })
})
