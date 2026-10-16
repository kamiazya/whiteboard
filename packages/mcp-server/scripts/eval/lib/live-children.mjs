// Every process the eval starts that can write into its scratch directory:
// the whiteboard server behind each MCP client, and each trial's `claude`
// (which runs a server of its own). `process.exit` ends only the eval, so a
// child still running at a signal is orphaned and writes the data dir —
// identity file included — back after the exit hook removed it. A signal
// therefore stops them first — a close, then a kill of whatever ignored it,
// waited out — and the exit hook still kills anything left before it removes
// anything, for the exits no signal began.

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
async function closeLiveChildren(timeoutMs) {
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

const isRunning = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Closes every live child, then kills what the close left running and waits —
 * up to `killWaitMs` — for each to be gone. A SIGKILL is only queued when
 * `process.kill` returns, and a write the child is already making still lands,
 * so removing the scratch on the strength of the signal alone races it. A
 * child confirmed gone is forgotten, so the exit hook never signals a pid the
 * system has since handed to another process.
 */
export async function stopLiveChildren(closeMs, killWaitMs = 2_000) {
  await closeLiveChildren(closeMs)
  killLiveChildren()
  const deadline = Date.now() + killWaitMs
  for (const child of [...live]) {
    const pid = child.pid()
    if (typeof pid !== 'number') continue
    // Polled rather than awaited on an event: a tracked child is known by its
    // pid alone. A dead direct child stays visible until the event loop reaps
    // it, which these yields give it the chance to do.
    while (isRunning(pid) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (!isRunning(pid)) live.delete(child)
  }
}

/**
 * Turns SIGINT/SIGTERM into a clean exit with `code`: `stop` runs first (a
 * second signal stops waiting for it), and the exit hook does the rest.
 *
 * Stopping a child closes the client the main flow may be awaiting — its
 * connect, mid-handshake, rejects with "Not connected" — and that rejection
 * reaches the top level while `stop` is still waiting. Once interrupted, such
 * a failure is the interrupt's own consequence, so it is swallowed rather than
 * left to end the run with exit 1.
 */
export function exitOnSignal(code, stop) {
  let interrupted = false
  const interrupt = async () => {
    if (interrupted) process.exit(code)
    interrupted = true
    process.on('uncaughtException', () => {})
    await stop()
    process.exit(code)
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt)
}
