/**
 * Ask a process to exit, wait a bounded time, and force it if it will not.
 *
 * Both stop commands (`daemon stop`, `server stop`) run this sequence, and
 * what differs between them is passed in rather than copied: the SIGTERM
 * window and poll interval, whether a pid that outlives the window is first
 * re-identified (a pid may have been reused by an unrelated process, and
 * SIGKILL is the one signal that cannot be walked back), and how long to
 * wait for the kill to take. What each caller does with the outcome — which
 * record it removes, what it tells the operator — stays with the caller.
 *
 * Every wait is a poll of `isAlive` bounded by a deadline, never a fixed
 * sleep, so a process that is gone ends the wait at once and one that is not
 * cannot hold the command past the bound.
 */

export interface TerminateOptions {
  pid: number
  isAlive: (pid: number) => boolean
  kill: (pid: number, signal: NodeJS.Signals) => void
  sleep: (ms: number) => Promise<void>
  /** How long SIGTERM gets before the process is forced. */
  timeoutMs: number
  pollMs: number
  /** How long to wait for the process to be gone after SIGKILL; 0 sends it and returns. */
  killWaitMs: number
  /** Asked once the SIGTERM window has lapsed; `false` withholds SIGKILL. */
  confirmKill?: () => Promise<boolean>
}

export type TerminateOutcome =
  /** SIGTERM could not be sent; nothing was waited for. */
  | { kind: 'signal-failed'; error: unknown }
  /** The process left within the SIGTERM window. */
  | { kind: 'exited' }
  /** The window lapsed and SIGKILL was sent. */
  | { kind: 'killed' }
  /** The window lapsed and `confirmKill` declined SIGKILL. */
  | { kind: 'kill-withheld' }

async function pollUntilGone(
  { pid, isAlive, sleep, pollMs }: Pick<TerminateOptions, 'pid' | 'isAlive' | 'sleep' | 'pollMs'>,
  windowMs: number,
): Promise<boolean> {
  const deadline = Date.now() + windowMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(Math.min(pollMs, deadline - Date.now()))
  }
  return !isAlive(pid)
}

export async function terminateAndWait(options: TerminateOptions): Promise<TerminateOutcome> {
  const { pid, kill, timeoutMs, killWaitMs, confirmKill } = options
  try {
    kill(pid, 'SIGTERM')
  } catch (error) {
    return { kind: 'signal-failed', error }
  }

  if (await pollUntilGone(options, timeoutMs)) return { kind: 'exited' }
  if (confirmKill && !(await confirmKill())) return { kind: 'kill-withheld' }

  try {
    kill(pid, 'SIGKILL')
  } catch {
    // The process left between the last check and the signal.
  }
  await pollUntilGone(options, killWaitMs)
  return { kind: 'killed' }
}
