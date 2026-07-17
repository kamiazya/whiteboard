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
}

/**
 * Wires stdin EOF/close/error and SIGTERM/SIGINT into a single once-guarded
 * shutdown that closes the MCP server (best-effort, bounded by
 * GRACEFUL_SHUTDOWN_TIMEOUT_MS) and then exits the process. An unref'd
 * hard-exit timer guarantees termination even if server.close() hangs, so
 * the timer itself never keeps the event loop alive.
 *
 * Only call this from the stdio entrypoint's main(). createExcalidrawMcpServer
 * is reused per-request by the HTTP /mcp handler, and installing process-level
 * stdin/signal listeners there would leak a listener per request and could
 * exit the long-lived HTTP daemon on an unrelated client's disconnect.
 */
export function installStdioLifecycle(deps: StdioLifecycleDeps): (exitCode?: number) => void {
  let shuttingDown = false

  const shutdown = (exitCode = 0): void => {
    if (shuttingDown) return
    shuttingDown = true

    // unref so the pending timer never keeps the event loop alive on its own.
    const hardExitTimer = setTimeout(() => {
      log.warning('graceful MCP shutdown timed out, forcing exit')
      deps.exit(exitCode)
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS).unref()

    deps
      .closeServer()
      .catch((err: unknown) => {
        log.warning(
          { err: err instanceof Error ? err : new Error(String(err)) },
          'error while closing MCP server during shutdown',
        )
      })
      .finally(() => {
        clearTimeout(hardExitTimer)
        deps.exit(exitCode)
      })
  }

  deps.stdin.once('end', () => shutdown(0))
  deps.stdin.once('close', () => shutdown(0))
  deps.stdin.once('error', () => shutdown(0))
  deps.signals.on('SIGTERM', () => shutdown(0))
  deps.signals.on('SIGINT', () => shutdown(0))

  return shutdown
}
