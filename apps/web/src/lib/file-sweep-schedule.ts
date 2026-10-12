/**
 * When the browser keeper's file sweep runs. Two triggers, both here:
 *
 * - `scheduleFileSweep`: once per page load, well after it, in an idle slot.
 *   Late and idle so it never competes with what the page loads, and so the
 *   writes a page makes as it opens have landed.
 * - `sweepAfterPurge`: right after a trash entry is purged for good, which
 *   is when that document's images stop being named by anything — reclaimed
 *   then rather than at the next page load.
 *
 * What neither can see — another tab's save in flight, an upload whose node
 * is not saved yet — is the sweep's own fence and grace window.
 *
 * Its own module, and the sweep reached by a dynamic import, because the
 * entry imports this: the sweep walks workspace records and pulls loro-crdt
 * with it, which the entry chunk must not (`entry-graph-loro-free.test.ts`).
 * `file-sweep-trigger-one-place.test.ts` keeps every trigger here.
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

async function sweepNow(dbName?: string): Promise<BrowserFileSweepResult> {
  const { sweepUnreferencedFiles } = await import('./browser-file-sweep.js')
  return sweepUnreferencedFiles(dbName === undefined ? {} : { dbName })
}

function reportSweep(sweep: Promise<BrowserFileSweepResult>, what: string): void {
  sweep.then(
    (result) => log.info(`${what} finished`, result),
    (err: unknown) => log.warn(`${what} failed`, { err }),
  )
}

export function scheduleFileSweep({
  sweep = () => sweepNow(),
  wait = idleAfterLoad,
}: {
  sweep?: () => Promise<BrowserFileSweepResult>
  wait?: (run: () => void) => void
} = {}): void {
  // A browser without IndexedDB keeps no workspace and no files.
  if (typeof indexedDB === 'undefined') return
  wait(() => reportSweep(sweep(), 'file sweep'))
}

/**
 * Not awaited by design: the purge has landed whatever the sweep finds, and
 * a sweep that cannot judge stands down by itself.
 */
export function sweepAfterPurge(
  dbName: string | undefined,
  { sweep = sweepNow }: { sweep?: (dbName?: string) => Promise<BrowserFileSweepResult> } = {},
): void {
  reportSweep(sweep(dbName), 'file sweep after purge')
}
