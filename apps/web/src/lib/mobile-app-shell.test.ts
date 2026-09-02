/**
 * App-shell hardening for touch browsers. Two halves:
 * - the gesture guards (this module): Safari's proprietary pinch events
 *   must be cancelled or the PAGE zooms underneath the app's own gestures;
 * - the viewport meta (index.html): asserted here from the source file so
 *   a refactor cannot silently drop `maximum-scale` (which is also what
 *   stops iOS auto-zooming focused inputs), `viewport-fit=cover`, or
 *   `interactive-widget=resizes-content`.
 */
import { describe, expect, it } from 'vitest'
import indexHtml from '../../index.html?raw'
import { installMobileAppShellGuards } from './mobile-app-shell.js'

describe('installMobileAppShellGuards', () => {
  it('cancels Safari pinch gesture events at the document', () => {
    const uninstall = installMobileAppShellGuards(document)
    try {
      for (const type of ['gesturestart', 'gesturechange']) {
        const event = new Event(type, { cancelable: true, bubbles: true })
        document.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(true)
      }
    } finally {
      uninstall()
    }
  })

  it('uninstall removes the guards', () => {
    const uninstall = installMobileAppShellGuards(document)
    uninstall()
    const event = new Event('gesturestart', { cancelable: true, bubbles: true })
    document.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('app-shell viewport meta', () => {
  it('pins the app-like viewport: no user scaling, cover the safe areas', () => {
    const viewport = indexHtml.match(/name="viewport"[\s\S]*?content="([^"]*)"/)?.[1] ?? ''
    expect(viewport).toContain('width=device-width')
    expect(viewport).toContain('maximum-scale=1')
    expect(viewport).toContain('user-scalable=no')
    expect(viewport).toContain('viewport-fit=cover')
  })
})

describe('viewport meta', () => {
  const viewport = /<meta\s+name="viewport"\s+content="([^"]+)"/.exec(indexHtml)?.[1] ?? ''

  it('was found in index.html at all', () => {
    // A regex that stops matching would report every key below as missing,
    // which sends the reader to the wrong file.
    expect(viewport).toContain('width=device-width')
  })

  it('asks the browser to resize the layout viewport for the on-screen keyboard', () => {
    // Without this the keyboard only shrinks the VISUAL viewport, and the
    // formatting strip has to chase that from script a frame at a time —
    // which on a fling it cannot win (see lib/software-keyboard.ts). Chrome
    // and Firefox honour the key; an engine that does not simply ignores it.
    expect(viewport).toContain('interactive-widget=resizes-content')
  })
})
