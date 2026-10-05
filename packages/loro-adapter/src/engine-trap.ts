/**
 * Whether a throw is the CRDT engine's WASM aborting, as opposed to it
 * refusing an input.
 *
 * Loro compiles its Rust panics to a `RuntimeError: unreachable` and, from the
 * panic on, leaves the `LoroDoc` that was inside the call holding a lock it
 * never released: every later call on THAT instance answers a "Locking order
 * violation" trap of its own. So a caller that keeps a document cached must
 * drop the instance on a trap, and must not drop it on a refused input, which
 * leaves the instance as it was.
 *
 * A fresh instance is no guarantee either: the trap can leave the engine's
 * memory damaged for the whole process. Measured on loro-crdt 1.13.6, after a
 * 4 Mi-character import trapped, fresh instances still imported a
 * 64 Ki-character insert but trapped within a millisecond on 128 Ki and
 * larger. Dropping the instance is still what a caller can do; it does not
 * promise the next large write succeeds.
 *
 * Matched by name and message rather than `instanceof
 * WebAssembly.RuntimeError`, which a trap raised in another realm (a worker, a
 * test sandbox) does not satisfy.
 */
export function isEngineTrap(err: unknown): boolean {
  return (
    err instanceof Error && err.name === 'RuntimeError' && err.message.startsWith('unreachable')
  )
}
