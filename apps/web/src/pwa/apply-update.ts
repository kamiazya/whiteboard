import { getAppLogger } from '../lib/app-logger.js'
import { reloadFresh } from './reload-fresh.js'

const log = getAppLogger('apply-update')

/**
 * How long a requested swap may take before it is declared lost.
 *
 * A swap normally lands within a second or two, so this is slack for a slow
 * machine rather than a tuning knob: a recovery that fires on a swap that was
 * merely slow costs a reload the user asked for anyway.
 */
export const SWAP_DEADLINE_MS = 10_000

export interface UpdateApplierOptions {
  /** Asks the waiting worker to take over and reloads the page once it has. */
  readonly apply: () => Promise<void>
  /** What to do when the swap never lands. Defaults to a reload that bypasses every worker. */
  readonly recover?: () => void | Promise<void>
  readonly deadlineMs?: number
}

/**
 * `skipWaiting` is a request, not a command: the browser activates the waiting
 * worker only once it has stopped the one in charge, and a page it still
 * controls can undo that. Chrome stops the old worker first; a request the page
 * sends in that window starts it again, the activation waiting on the stop is
 * lost, and the new worker stays waiting until the browser's own lame-duck
 * ceiling — five minutes — however often it is asked again. Nothing the page
 * can ask of the worker clears that, but unregistering does, which is what
 * `reloadFresh` starts with.
 *
 * A swap that lands reloads the page and takes this timer with it, so the timer
 * firing is itself the signal that it did not.
 */
export function createUpdateApplier({
  apply,
  recover = () => reloadFresh(),
  deadlineMs = SWAP_DEADLINE_MS,
}: UpdateApplierOptions): () => Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined

  return async () => {
    deadline ??= setTimeout(() => {
      deadline = undefined
      log.warn('the waiting service worker did not take over; reloading without it')
      void recover()
    }, deadlineMs)
    try {
      await apply()
    } catch (err) {
      // Nothing was waiting to take over, so there is nothing to recover.
      clearTimeout(deadline)
      deadline = undefined
      throw err
    }
  }
}
