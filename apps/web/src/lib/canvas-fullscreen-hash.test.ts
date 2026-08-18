import { describe, expect, it } from 'vitest'
import { syncFullscreenHash } from './canvas-fullscreen-hash.js'

// The DocumentPage effect that mirrors `isFullscreen` into the URL hash used
// to clobber any other hash on mount, breaking the add-library import
// flow that opens the canvas with `#addLibrary=…`. The contract this
// helper enforces:
//   1. Going INTO fullscreen rewrites the hash to `#fullscreen` even if a
//      non-fullscreen hash existed (the user explicitly switched modes).
//   2. Going OUT of fullscreen clears the hash *only* when the current
//      hash is `#fullscreen` — never touching a third-party hash like
//      `#addLibrary=…` that the library-import effect needs to read.

describe('syncFullscreenHash', () => {
  // Convenience helper to drive the function deterministically without
  // needing an actual jsdom Location/History pair.
  function run(
    isFullscreen: boolean,
    initial: { pathname: string; search: string; hash: string },
  ): { hash: string; replaceCalls: number } {
    let hash = initial.hash
    let replaceCalls = 0
    syncFullscreenHash(isFullscreen, {
      location: {
        get pathname() {
          return initial.pathname
        },
        get search() {
          return initial.search
        },
        get hash() {
          return hash
        },
      },
      history: {
        replaceState(_state, _title, url) {
          replaceCalls++
          // Mirror the URL parser the helper hands the History API so the
          // assertions below see the post-replace hash exactly as the
          // browser would.
          const parsed = new URL(url, 'http://example.test')
          hash = parsed.hash
        },
        get state() {
          return null
        },
      },
    })
    return { hash, replaceCalls }
  }

  it('preserves a non-fullscreen hash on initial mount in non-fullscreen mode', () => {
    const out = run(false, {
      pathname: '/w/ws_a/document/design',
      search: '',
      hash: '#addLibrary=https%3A%2F%2Flibs.example%2Fpack',
    })
    expect(out.hash).toBe('#addLibrary=https%3A%2F%2Flibs.example%2Fpack')
    expect(out.replaceCalls).toBe(0)
  })

  it('writes #fullscreen when toggled on, even if a different hash existed', () => {
    const out = run(true, {
      pathname: '/w/ws_a/document/design',
      search: '?x=1',
      hash: '#addLibrary=foo',
    })
    expect(out.hash).toBe('#fullscreen')
    expect(out.replaceCalls).toBe(1)
  })

  it('clears the hash only when leaving fullscreen mode', () => {
    const out = run(false, {
      pathname: '/w/ws_a/document/design',
      search: '',
      hash: '#fullscreen',
    })
    expect(out.hash).toBe('')
    expect(out.replaceCalls).toBe(1)
  })

  it('is a no-op when fullscreen state already matches the hash', () => {
    const a = run(true, { pathname: '/c', search: '', hash: '#fullscreen' })
    expect(a.replaceCalls).toBe(0)
    const b = run(false, { pathname: '/c', search: '', hash: '' })
    expect(b.replaceCalls).toBe(0)
  })

  it('does not strip an unrelated hash when toggling off (defensive)', () => {
    // Hypothetical race: fullscreen flipped off via an external hashchange
    // that already updated the URL. The effect must not aggressively
    // re-write the hash to empty just because isFullscreen is false.
    const out = run(false, {
      pathname: '/w/ws_a/document/design',
      search: '',
      hash: '#someOther=1',
    })
    expect(out.hash).toBe('#someOther=1')
    expect(out.replaceCalls).toBe(0)
  })
})
