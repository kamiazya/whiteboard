import { useEffect } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { asksForReturn } from '../lib/connection-state.js'
import { launchQueueOf, newCanvasLaunchConsumer } from '../lib/launch-queue.js'
import { NEW_CANVAS_SHORTCUT } from '../lib/new-canvas-shortcut.js'
import { getShellConnection } from '../lib/shell-status-store.js'

// Read when the module is evaluated: App imports it statically, so this runs
// before the first render and before the address sync rewrites the URL.
const DOCUMENT_URL_AT_LOAD = typeof window === 'undefined' ? '' : window.location.href

function tabHoldsWork(): boolean {
  const state = getShellConnection()?.state
  return state !== undefined && asksForReturn(state)
}

/**
 * Routes the installed app's "New canvas" shortcut when the app is already
 * open: the manifest's `focus-existing` delivers the launch here rather than
 * navigating the window, so without a consumer the shortcut only focuses it.
 */
export function useNewCanvasLaunches(navigate: NavigateFunction, daemonKept: boolean): void {
  useEffect(() => {
    const queue = launchQueueOf(window)
    if (queue === null) return
    queue.setConsumer(
      newCanvasLaunchConsumer(window, {
        documentUrl: DOCUMENT_URL_AT_LOAD,
        holdsWork: tabHoldsWork,
        keptByBrowser: () => !daemonKept,
        open: () => {
          void navigate(NEW_CANVAS_SHORTCUT.url)
        },
      }),
    )
  }, [navigate, daemonKept])
}
