/**
 * What a smoke needs to know about the server subprocess it drives: what it
 * wrote to stderr, and whether it is gone.
 *
 * A child that has exited answers nothing, so every request waiting on it
 * fails at once with how it ended. Waiting out the request timeout instead
 * names the first request, and the child's real error ("Cannot find module",
 * a crash at startup) arrives only after it.
 *
 * `pending` is the caller's map of in-flight requests, each `{ reject }`.
 */
export function watchChild(child, pending) {
  let stderr = ''
  let ended = null
  const end = (reason) => {
    ended ??= new Error(`server process ${reason} before answering`)
    for (const { reject } of pending.values()) reject(ended)
    pending.clear()
  }
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  child.on('exit', (code, signal) =>
    end(signal ? `was killed by ${signal}` : `exited with code ${code}`),
  )
  child.on('error', (err) => end(`could not start (${err.message})`))
  // Writing to a child that has already exited is an EPIPE here, not a crash.
  child.stdin.on('error', () => {})
  return { stderr: () => stderr, ended: () => ended }
}
