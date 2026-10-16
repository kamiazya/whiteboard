// Every process the eval starts that can write into its scratch directory:
// the whiteboard server behind each MCP client, and each trial's `claude`
// (which runs a server of its own). `process.exit` ends only the eval, so a
// child still running at a signal is orphaned and writes the data dir —
// identity file included — back after the exit hook removed it. A signal
// therefore closes them first, and the exit hook kills whatever a hung close
// left behind before it removes anything.

/** @typedef {{ close: () => Promise<void>, pid: () => number | null | undefined }} LiveChild */

/** @type {Set<LiveChild>} */
const live = new Set()

/**
 * @param {LiveChild} child
 * @returns {() => void} forgets the child, once it has ended by itself
 */
export function trackChild(child) {
  live.add(child)
  return () => live.delete(child)
}

/** Closes every live child gracefully, giving up after `timeoutMs`. */
export async function closeLiveChildren(timeoutMs) {
  let timer
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  await Promise.race([Promise.allSettled([...live].map((child) => child.close())), bound])
  clearTimeout(timer)
}

/** Synchronous, so it can run in an `exit` hook. */
export function killLiveChildren() {
  for (const child of live) {
    const pid = child.pid()
    if (typeof pid !== 'number') continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}
