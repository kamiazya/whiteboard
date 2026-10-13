/**
 * How a daemon answer's body is read, for both composition roots.
 *
 * One policy, decided here once: a body cut off mid-stream is the network's
 * failure (`FetchFailedError`), while a body that ARRIVED and is not JSON is
 * the keeper's, answered as `undefined` so the caller's own contract parse
 * fails and reports it as drift. Every reader of a JSON answer — the web app's
 * `readDaemonJson`, `refusalReasonOf`, `requestReplicaKey` — reads through
 * `readJsonOrUndefined`, so the three cannot decide it three ways.
 *
 * `reach` is also how a caller names a rejected fetch. Not every fetch site
 * uses it yet: a site that classifies a failed fetch by its own `catch` still
 * sees a bare `TypeError` there.
 */

/**
 * A fetch, or the read of its body, rejected: the keeper was not reached.
 *
 * Named at the call because a failed fetch rejects with a bare `TypeError`,
 * the same class a defect in this device's own reads and writes throws — so
 * by the time a `catch` sees one, the class can no longer say which it was.
 */
export class FetchFailedError extends Error {
  override readonly name = 'FetchFailedError'
  constructor(cause: unknown) {
    super('the keeper could not be reached', { cause })
  }
}

/** `attempt`, with its rejection named a `FetchFailedError`. */
export async function reach<T>(attempt: Promise<T>): Promise<T> {
  try {
    return await attempt
  } catch (err) {
    throw new FetchFailedError(err)
  }
}

/**
 * The body as JSON, `undefined` when it arrived and is not JSON (an empty
 * body included), and a `FetchFailedError` when it never fully arrived.
 */
export async function readJsonOrUndefined(res: Response): Promise<unknown> {
  const text = await reach(res.text())
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
