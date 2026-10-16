import { NEW_CANVAS_SHORTCUT } from './new-canvas-shortcut.js'

/**
 * The slice of the Launch Handler API (https://wicg.github.io/web-app-launch/)
 * this app reads. Typed here because TypeScript's DOM lib does not carry it:
 * only Chromium implements it. `targetURL` is nullable in the spec's IDL.
 */
interface LaunchParamsSlice {
  readonly targetURL?: string | null
}
type LaunchConsumer = (params: LaunchParamsSlice) => void
interface LaunchQueueSlice {
  setConsumer(consumer: LaunchConsumer): void
}

/** The window's launch queue, or null where the browser has none. */
export function launchQueueOf(win: object): LaunchQueueSlice | null {
  if (!('launchQueue' in win)) return null
  const queue = win.launchQueue
  if (typeof queue !== 'object' || queue === null || !('setConsumer' in queue)) return null
  const setConsumer = queue.setConsumer
  if (typeof setConsumer !== 'function') return null
  return { setConsumer: (consumer) => void setConsumer.call(queue, consumer) }
}

// Windows whose queue has delivered its first launch, so a consumer
// registered again (a re-render, StrictMode's double effect) does not take a
// later launch for the one that loaded the document.
const deliveredFirst = new WeakSet<object>()

export interface NewCanvasLaunchOptions {
  /** The URL this document was loaded at, before the router rewrote it. */
  readonly documentUrl: string
  /** Whether the tab holds work an in-app leave would lose. */
  readonly holdsWork: () => boolean
  readonly open: () => void
}

/**
 * The consumer for one queue: a launch whose target asks for a new canvas
 * opens the shortcut's URL in-app, so the list's own create path runs.
 *
 * Two launches are deliberately left alone:
 * - The one that LOADED this document. The spec enqueues LaunchParams on every
 *   launch, a cold start included, and that document already sits at the
 *   target URL — acting on it as well would create a second document.
 * - Any launch while the tab holds work a leave would lose (the rule the
 *   tab-close prompt follows): leaving the document drops a write still
 *   waiting for a retry, and the window is only focused instead.
 *
 * Other targets only focus the window, which the manifest's `focus-existing`
 * has already done.
 */
export function newCanvasLaunchConsumer(
  win: object,
  options: NewCanvasLaunchOptions,
): LaunchConsumer {
  return (params) => {
    const first = !deliveredFirst.has(win)
    deliveredFirst.add(win)
    const target = params.targetURL
    if (typeof target !== 'string') return
    if (first && target === options.documentUrl) return
    if (!NEW_CANVAS_SHORTCUT.isRequestedBy(searchParamsOf(target))) return
    if (options.holdsWork()) return
    options.open()
  }
}

function searchParamsOf(url: string): URLSearchParams {
  try {
    return new URL(url).searchParams
  } catch {
    return new URLSearchParams()
  }
}
