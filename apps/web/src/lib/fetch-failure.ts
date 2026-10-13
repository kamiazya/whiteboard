/**
 * A fetch, or the read of its body, rejected: the keeper was not reached.
 *
 * Named at the call because a failed fetch rejects with a bare `TypeError`,
 * the same class a defect in this device's own reads and writes throws — so
 * by the time a `catch` sees one, the class can no longer say which it was.
 *
 * A leaf module on purpose: every daemon client reaches its fetches through
 * this, so it must not carry any one flow's failure policy into their graphs.
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
