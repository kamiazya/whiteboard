/**
 * Whole-app fullscreen: the shell's concern, read by every page.
 *
 * The TARGET is `document.documentElement`, not a page's `<main>`. The
 * question fullscreen answers is how much of the screen the app gets, and
 * that is the same question on every page — which is why the control lives
 * in the AppShell row (DESIGN.md's shell rule) and no page threads a
 * fullscreen target down any more. It used to be the browser document
 * page's `<main>`, which cost three things: the daemon page had no
 * fullscreen at all, the target needed a background of its own because an
 * element promoted to the top layer leaves the body's behind, and the
 * affordance rode in the document's top bar as a fourth kind of control.
 *
 * `isFullscreen` follows the DOCUMENT (`fullscreenchange`), not our own
 * click: fullscreen can also be left with Escape or the browser's chrome.
 * `supported` is read once per mount — it cannot change without a
 * navigation — and is false on iPhone Safari (video-only API) and in jsdom,
 * where the control is hidden rather than offered inert.
 */

import { useCallback, useEffect, useState } from 'react'
import { getAppLogger } from '../lib/app-logger.js'
import { isFullscreenSupported } from '../lib/fullscreen-support.js'

const log = getAppLogger('fullscreen')

function readIsFullscreen(): boolean {
  // Boolean(): jsdom leaves fullscreenElement undefined rather than null,
  // and `undefined !== null` once read as "in fullscreen" on first mount.
  return Boolean(document.fullscreenElement)
}

export function useFullscreen(): {
  readonly isFullscreen: boolean
  readonly supported: boolean
  readonly toggle: () => void
} {
  const [isFullscreen, setIsFullscreen] = useState(readIsFullscreen)
  const [supported] = useState(isFullscreenSupported)
  useEffect(() => {
    const sync = () => setIsFullscreen(readIsFullscreen())
    sync()
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  // requestFullscreen can REJECT (Permissions-Policy, an iframe without
  // allow="fullscreen", no user activation) — a swallowed rejection is
  // unhandled-rejection noise, so both directions log.
  const toggle = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch((err) => log.warn('exitFullscreen failed', err))
    } else {
      document.documentElement
        .requestFullscreen()
        .catch((err) => log.warn('requestFullscreen rejected', err))
    }
  }, [])
  return { isFullscreen, supported, toggle }
}
