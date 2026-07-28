import { getLogger } from '../log.js'

const log = getLogger('stdio-lifecycle')

/**
 * StdioServerTransport (SDK) only listens for 'data' and 'error' on stdin —
 * it never installs an 'end' handler, so a client disconnect (parent process
 * exit, pipe close) leaves the process parked on a stdin that will never
 * produce another byte. Node's read loop keeps re-issuing reads against the
 * closed/EOF fd, which is the busy-spin observed in production (fs read
 * completion callbacks looping at ~70-80% CPU indefinitely). Closing the
 * server ourselves on stdin EOF/close/error removes that window by exiting
 * before the spin can start.
 */
export const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2000

type MinimalStdin = Pick<NodeJS.ReadableStream, 'once'>

export interface StdioLifecycleDeps {
  stdin: MinimalStdin
  signals: {
    on: (signal: NodeJS.Signals, listener: () => void) => unknown
  }
  closeServer: () => Promise<void>
  exit: (code: number) => void
  /**
   * Additional shutdown work to await alongside closeServer() before
   * exiting (e.g. flushing OpenTelemetry spans), bounded by the same
   * GRACEFUL_SHUTDOWN_TIMEOUT_MS budget. Defaults to a no-op.
   */
  shutdownExtra?: () => Promise<void>
}

/**
 * Wires stdin EOF/close/error and SIGTERM/SIGINT into a single once-guarded
 * shutdown that closes the MCP server (best-effort, bounded by
 * GRACEFUL_SHUTDOWN_TIMEOUT_MS) and then exits the process. An unref'd
 * hard-exit timer guarantees termination even if server.close() hangs, so
 * the timer itself never keeps the event loop alive.
 *
 * Only call this from the stdio entrypoint's main(). createMcpServer
 * is reused per-request by the HTTP /mcp handler, and installing process-level
 * stdin/signal listeners there would leak a listener per request and could
 * exit the long-lived HTTP daemon on an unrelated client's disconnect.
 */
export function installStdioLifecycle(deps: StdioLifecycleDeps): (exitCode?: number) => void {
  let shuttingDown = false
  // Guards deps.exit() from ever firing twice for one shutdown: the
  // hard-exit timer and the closeServer()/shutdownExtra() settlement race
  // each other, and either one can win. Without this flag a slow
  // closeServer() that settles just after the timer fires would call
  // deps.exit() a second time.
  let exited = false

  const exitOnce = (exitCode: number): void => {
    if (exited) return
    exited = true
    deps.exit(exitCode)
  }

  const shutdown = (exitCode = 0): void => {
    if (shuttingDown) return
    shuttingDown = true

    // unref so the pending timer never keeps the event loop alive on its own.
    const hardExitTimer = setTimeout(() => {
      log.warning('graceful MCP shutdown timed out, forcing exit')
      exitOnce(exitCode)
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS).unref()

    const shutdownExtra = deps.shutdownExtra ?? (() => Promise.resolve())

    // deps.closeServer() / shutdownExtra() are typed as returning a Promise,
    // but a caller can still throw synchronously before ever producing one
    // (e.g. a bug in the SDK's close() path). Calling through settle() turns
    // that throw into a rejection so it always lands in the Promise.allSettled
    // below instead of escaping this function and skipping the finally block.
    const settle = (fn: () => Promise<void>): Promise<void> => {
      try {
        return fn()
      } catch (err) {
        return Promise.reject(err)
      }
    }

    Promise.allSettled([settle(deps.closeServer), settle(shutdownExtra)])
      .then((results) => {
        for (const result of results) {
          if (result.status === 'rejected') {
            const err = result.reason
            log.warning(
              { err: err instanceof Error ? err : new Error(String(err)) },
              'error during MCP shutdown',
            )
          }
        }
      })
      .finally(() => {
        clearTimeout(hardExitTimer)
        exitOnce(exitCode)
      })
  }

  deps.stdin.once('end', () => shutdown(0))
  deps.stdin.once('close', () => shutdown(0))
  // A stdin transport failure is not a clean disconnect: exit non-zero so
  // supervisors and clients can tell the two apart.
  deps.stdin.once('error', () => shutdown(1))
  deps.signals.on('SIGTERM', () => shutdown(0))
  deps.signals.on('SIGINT', () => shutdown(0))

  return shutdown
}
