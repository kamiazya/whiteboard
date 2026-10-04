/**
 * Runs operations one at a time per key, in submission order, and lets
 * different keys proceed independently. A read-then-write pair is two steps
 * against a store, and an interleaved pair on the same key produces exactly
 * the duplicate or lost update the first step checks for.
 *
 * A rejection does not poison the queue: the next operation on that key still
 * runs. Every settled key is forgotten, so the map's size is the number of
 * keys with work in flight rather than every key ever seen.
 *
 * Not reentrant: an operation that submits to its own key waits for itself.
 */
export class KeyedSerializer {
  readonly #tails = new Map<string, Promise<void>>()

  /** Keys with an operation queued or running. */
  get pendingKeys(): number {
    return this.#tails.size
  }

  run<T>(key: string, body: () => Promise<T>): Promise<T> {
    // Every stored tail is already caught, so `previous` never rejects.
    const previous = this.#tails.get(key) ?? Promise.resolve()
    const next = previous.then(async () => {
      try {
        return await body()
      } finally {
        // Inside the chain rather than after it, so the entry is gone before
        // the caller's `await` resumes. Only the last queued operation clears
        // it; an earlier one finding a newer tail leaves the queue alone.
        if (this.#tails.get(key) === tail) this.#tails.delete(key)
      }
    })
    const tail = next.then(
      () => undefined,
      () => undefined,
    )
    this.#tails.set(key, tail)
    return next
  }
}
