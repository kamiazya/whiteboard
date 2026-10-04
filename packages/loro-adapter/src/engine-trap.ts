/**
 * Whether a throw is the CRDT engine's WASM aborting, as opposed to it
 * refusing an input.
 *
 * Loro compiles its Rust panics to a `RuntimeError: unreachable` and, from the
 * panic on, leaves the `LoroDoc` that was inside the call holding a lock it
 * never released: every later call on THAT instance answers a "Locking order
 * violation" trap of its own, while a fresh instance works. So a caller that
 * keeps a document cached must drop the instance on a trap, and must not drop
 * it on a refused input, which leaves the instance as it was. Matched by name
 * and message rather than `instanceof WebAssembly.RuntimeError`, which a trap
 * raised in another realm (a worker, a test sandbox) does not satisfy.
 */
export function isEngineTrap(err: unknown): boolean {
  return (
    err instanceof Error && err.name === 'RuntimeError' && err.message.startsWith('unreachable')
  )
}
