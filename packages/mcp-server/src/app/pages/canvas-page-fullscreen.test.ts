import { describe, expect, it } from 'vitest'
import {
  detectInitialFullscreen,
  isFullscreenHash,
} from './canvas-page-fullscreen.js'

describe('isFullscreenHash', () => {
  it('matches the canonical fragment', () => {
    expect(isFullscreenHash('#fullscreen')).toBe(true)
  })

  it('rejects empty / unrelated / case-shifted fragments', () => {
    expect(isFullscreenHash('')).toBe(false)
    expect(isFullscreenHash('#other')).toBe(false)
    expect(isFullscreenHash('#FULLSCREEN')).toBe(false)
  })
})

describe('detectInitialFullscreen', () => {
  it('honours the #fullscreen hash even when the query is absent', () => {
    expect(
      detectInitialFullscreen({ hash: '#fullscreen', search: new URLSearchParams() }),
    ).toBe(true)
  })

  it('falls back to ?fullscreen=1 for legacy callers', () => {
    expect(
      detectInitialFullscreen({ hash: '', search: new URLSearchParams('fullscreen=1') }),
    ).toBe(true)
  })

  it('returns false when neither signal is present', () => {
    expect(
      detectInitialFullscreen({ hash: '', search: new URLSearchParams() }),
    ).toBe(false)
  })

  it('treats fullscreen=0 (or any non-1 value) as not fullscreen', () => {
    expect(
      detectInitialFullscreen({ hash: '', search: new URLSearchParams('fullscreen=0') }),
    ).toBe(false)
    expect(
      detectInitialFullscreen({ hash: '', search: new URLSearchParams('fullscreen=true') }),
    ).toBe(false)
  })

  it('accepts a raw search string and parses it identically', () => {
    expect(detectInitialFullscreen({ hash: '', search: '?fullscreen=1' })).toBe(true)
    expect(detectInitialFullscreen({ hash: '', search: 'fullscreen=1' })).toBe(true)
  })
})
