/**
 * When the browser keeper's file sweep runs: once per page load, well after
 * it, in an idle slot.
 *
 * Its own module, and the sweep reached by a dynamic import, because the
 * entry imports this: the sweep walks workspace records and pulls loro-crdt
 * with it, which the entry chunk must not (`entry-graph-loro-free.test.ts`).
 *
 * Late and idle so it never competes with what the page loads, and so the
 * writes a page makes as it opens have landed; what it cannot see — another
 * tab's save in flight, an upload whose node is not saved yet — is the
 * sweep's own fence and grace window.
 */

import { getAppLogger } from './app-logger.js'
import type { BrowserFileSweepResult } from './browser-file-sweep.js'

const log = getAppLogger('file-sweep-schedule')

const AFTER_LOAD_MS = 30_000
/** Chromium runs an idle callback anyway once this elapses. */
const IDLE_DEADLINE_MS = 60_000

function idleAfterLoad(run: () => void): void {
  setTimeout(() => {
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: IDLE_DEADLINE_MS })
    } else run()
  }, AFTER_LOAD_MS)
}

async function sweepNow(): Promise<BrowserFileSweepResult> {
  const { sweepUnreferencedFiles } = await import('./browser-file-sweep.js')
  return sweepUnreferencedFiles()
}

export function scheduleFileSweep({
  sweep = sweepNow,
  wait = idleAfterLoad,
}: {
  sweep?: () => Promise<BrowserFileSweepResult>
  wait?: (run: () => void) => void
} = {}): void {
  // A browser without IndexedDB keeps no workspace and no files.
  if (typeof indexedDB === 'undefined') return
  wait(() => {
    sweep().then(
      (result) => log.info('file sweep finished', result),
      (err: unknown) => log.warn('file sweep failed', { err }),
    )
  })
}
