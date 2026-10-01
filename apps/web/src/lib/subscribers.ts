/**
 * A set of listeners and the two things ever done with one: subscribe, which
 * answers its own unsubscribe, and emit.
 *
 * Before this existed the same `Set` plus add/delete pair was written by hand
 * at fourteen sites, six of them inside one factory. A copy is not wrong,
 * but a change to the one behaviour that matters here — what emit does when
 * a listener unsubscribes or subscribes mid-emit, which is `Set` iteration's
 * answer and nobody else's — would have to be made fourteen times.
 */
export interface Subscribers<Args extends readonly unknown[]> {
  /** Registers the listener and answers the function that removes it. */
  readonly subscribe: (listener: (...args: Args) => void) => () => void
  /** Calls every listener subscribed at the time of the call, in subscription order. */
  readonly emit: (...args: Args) => void
  /** Drops every listener — a test reset's need, so a module-level store starts the next test empty. */
  readonly clear: () => void
}

export function createSubscribers<Args extends readonly unknown[] = []>(): Subscribers<Args> {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(...args) {
      for (const listener of listeners) listener(...args)
    },
    clear() {
      listeners.clear()
    },
  }
}
