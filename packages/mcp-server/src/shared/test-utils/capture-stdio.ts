import { vi } from 'vitest'
import { setStderrLogDestination } from '../../server/log.js'

/**
 * Runs `body` with `process.stdout` and `process.stderr` writes diverted into
 * strings, restoring both when it settles — resolved or rejected.
 *
 * The CLI entry points write their answer to the real streams, so a test of
 * what a command prints has to stand between them and the terminal.
 *
 * The logger's stderr destination is switched ON for as long as the capture
 * runs, whatever the suite's setup muted: stderr is the only diagnostic
 * channel `whiteboard mcp` and `whiteboard server run` expose, and a test
 * that asserts no secret reaches it has to see what `getLogger` writes there
 * too, not only the dispatcher's own `process.stderr.write`.
 */
export function captureStdio<T>(
  body: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []
  const writeStdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
  const writeStderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
  const restoreStderrLog = setStderrLogDestination(true)
  return body()
    .then((result) => ({ result, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') }))
    .finally(() => {
      restoreStderrLog()
      writeStdout.mockRestore()
      writeStderr.mockRestore()
    })
}
