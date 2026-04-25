import type { ChildProcess } from 'node:child_process'

/**
 * Monitor the child process after READY and run cleanup on exit.
 *
 * startHonoServer only rejects for failures before READY.
 * Exits after READY are handled here so the .port file is removed and
 * canvas_list does not report stale active sessions.
 */
export function monitorChildAfterReady(
  child: ChildProcess,
  cleanup: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  child.on('exit', (_code, _signal) => {
    cleanup()
    exit(1)
  })
}
