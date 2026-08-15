import { describe, expect, it } from 'vitest'
import { isFullscreenSupported } from './fullscreen-support.js'

function fakeDoc(props: Record<string, unknown>): Document {
  return props as unknown as Document
}

describe('isFullscreenSupported', () => {
  it('is false where the browser says fullscreen is unavailable (iPhone Safari)', () => {
    expect(isFullscreenSupported(fakeDoc({ fullscreenEnabled: false }))).toBe(false)
  })

  it('is true where the browser offers it', () => {
    expect(isFullscreenSupported(fakeDoc({ fullscreenEnabled: true }))).toBe(true)
  })

  it('honours the legacy WebKit answer when the standard one says no', () => {
    expect(
      isFullscreenSupported(fakeDoc({ fullscreenEnabled: false, webkitFullscreenEnabled: true })),
    ).toBe(true)
  })

  it('assumes supported where the property is absent (non-browser runtimes)', () => {
    // jsdom implements no fullscreen at all; hiding the affordance there
    // would mean tests exercising a UI no real browser shows.
    expect(isFullscreenSupported(fakeDoc({}))).toBe(true)
  })
})
