/**
 * App-shell hardening for touch browsers. Two halves:
 * - the gesture guards (this module): Safari's proprietary pinch events
 *   must be cancelled or the PAGE zooms underneath the app's own gestures;
 * - the viewport meta (index.html): asserted here from the source file so
 *   a refactor cannot silently drop `maximum-scale` (which is also what
 *   stops iOS auto-zooming focused inputs) or `viewport-fit=cover`.
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
