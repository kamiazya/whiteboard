import type { BackgroundWorker } from '../background-work.js'

/**
 * The wait behind giving back a workspace record nobody has used for a while.
 *
 * The cache owns no timer, so that whoever sets an idle time is a worker the
 * registry declares with its cost (`background-work.ts`); this is that worker.
 * Armed by `start`: a process that never arms it (the stdio entry, a test)
 * keeps what the bound keeps and releases nothing for being idle.
 */
let armed = false
const waiting = new Set<ReturnType<typeof setTimeout>>()

export function scheduleIdleRelease(run: () => void, ms: number): { cancel(): void } {
  if (!armed) return { cancel() {} }
  const timer = setTimeout(() => {
    waiting.delete(timer)
    run()
  }, ms)
  // A wait for housekeeping must not keep a daemon that is otherwise done alive.
  timer.unref()
  waiting.add(timer)
  return {
    cancel() {
      clearTimeout(timer)
      waiting.delete(timer)
    },
  }
}

export const recordIdleReleaseWorker: BackgroundWorker = {
  start() {
    armed = true
  },
  async stop() {
    armed = false
    for (const timer of waiting) clearTimeout(timer)
    waiting.clear()
  },
}
