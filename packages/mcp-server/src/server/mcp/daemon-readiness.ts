// Cold-start-under-contention retry orchestrator for the packaged-tarball smoke.
//
// The smoke has no daemon port or process handle to poll — the only lever it
// has is re-issuing the daemon-triggering RPC. Each attempt is expected to
// carry its own bounded timeout (see WHITEBOARD_SMOKE_RPC_TIMEOUT_MS at the
// call site), so this orchestrator only counts attempts; it never installs
// its own wall-clock timer.

/**
 * Matches the two startup-contention error strings that indicate "the daemon
 * has not finished cold-starting yet", not a real regression:
 *  - ensure-daemon.ts:152 `'Daemon startup timeout'`
 *  - daemon-lock.ts:70 `'Daemon startup lock timeout'`
 * Both consume the same startupTimeoutMs window and are the same
 * cold-start-under-contention family — re-issuing the RPC re-enters
 * ensureDaemon and can acquire the lock / finish the race on the next
 * attempt.
 */
export const DAEMON_STARTUP_CONTENTION_TOKEN = 'Daemon startup'

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message)
  }
  return String(err)
}

export function isDaemonStartupContentionError(err: unknown): boolean {
  return getErrorMessage(err).includes(DAEMON_STARTUP_CONTENTION_TOKEN)
}

export interface RetryDaemonStartupOptions<T> {
  attempt: () => Promise<T>
  maxRetries: number
  isRetryable?: (err: unknown) => boolean
  sleep?: (attemptIndex: number) => Promise<void>
}

/**
 * Retries `attempt()` up to `maxRetries` additional times (so `maxRetries +
 * 1` total calls) whenever it rejects with a retryable (startup-contention)
 * error. Any other rejection propagates immediately with no retry, so real
 * regressions are never masked. Exhausting the retry budget on a retryable
 * error rejects with a distinct message so callers can tell "still cold
 * after N windows" apart from "one window timed out".
 */
export async function retryDaemonStartup<T>({
  attempt,
  maxRetries,
  isRetryable = isDaemonStartupContentionError,
  sleep,
}: RetryDaemonStartupOptions<T>): Promise<T> {
  let lastError: unknown
  for (let attemptIndex = 0; attemptIndex <= maxRetries; attemptIndex++) {
    try {
      return await attempt()
    } catch (err) {
      lastError = err
      if (!isRetryable(err)) throw err
      if (attemptIndex < maxRetries && sleep) await sleep(attemptIndex)
    }
  }
  const message = getErrorMessage(lastError)
  throw new Error(
    `Daemon startup retry budget exhausted after ${maxRetries + 1} attempts: ${message}`,
  )
}
