// A panic aborts the wasm instance (`panic = "abort"`), and from the trap on
// the instance keeps answering over whatever state the panic interrupted. So a
// call that traps discards the instance (wasm-bindgen's reset-state function
// re-instantiates the module in place) and is refused; it is never retried,
// because a call that trapped once will trap again and may have been the one
// that damaged the state (owner decision q95). The next call runs on a fresh
// instance.
//
// What the old instance held is gone, and a number it handed out means
// something else (or nothing) in the new one, which numbers its handles from
// zero. Every handle therefore carries the generation it was minted in; a
// handle from an older one is refused, and a finalizer for one does nothing.

/** What releases a handle once the object naming it is collected; a `FinalizationRegistry`. */
export interface Finalizer {
  register(target: object, handle: number, token: object): void
  unregister(token: object): void
}

/** A call trapped; the instance was discarded and the next call runs on a fresh one. */
export class CoreInstanceTrapped extends Error {
  constructor(
    readonly operation: string,
    /** The generation the fresh instance is. */
    readonly generation: number,
    options?: ErrorOptions,
  ) {
    super(
      `${operation} trapped the wasm instance, which was reset; the call was not retried`,
      options,
    )
    this.name = 'CoreInstanceTrapped'
  }
}

/** A handle was minted by an instance that has since been discarded; its owner rebuilds what it held. */
export class CoreHandleLost extends Error {
  constructor(readonly operation: string) {
    super(`${operation}: the handle belongs to a wasm instance that was reset`)
    this.name = 'CoreHandleLost'
  }
}

/** The instance trapped and could not be reset; every later call is refused. */
export class CoreUnrecoverable extends Error {
  constructor(
    readonly operation: string,
    options?: ErrorOptions,
  ) {
    super(`${operation}: the wasm instance trapped and could not be reset`, options)
    this.name = 'CoreUnrecoverable'
  }
}

/**
 * Where a trap is recorded: fields first, then the message, as the daemon's
 * logger takes them. Only the export's name is given, never its input.
 */
export interface RecoveryLog {
  error(fields: { operation: string; generation: number }, message: string): void
}

/** Consecutive failed resets after which an instance is given up on. */
export const MAX_RESET_ATTEMPTS = 3

/** The glue calls recovery makes itself. */
interface ResettableGlue {
  abi_version(): string
  __wbg_reset_state(): void
}

/**
 * Whether a throw leaves the instance's own state unreliable: a
 * `WebAssembly.RuntimeError` (`unreachable` from the abort, an out-of-bounds
 * access, ...), or the engine's stack overflow, which unwinds past the
 * shadow-stack epilogue and leaves its pointer where the overflow was. Any
 * other `RangeError` (a string or array too long for the glue to build) is
 * raised on the JS side before the instance is entered, and leaves it whole.
 * Matched by name, as a trap raised in another realm (a worker, a test
 * sandbox) is not an `instanceof` this realm's classes.
 */
export function isInstanceTrap(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const { name, message } = err as { name?: unknown; message?: unknown }
  if (name === 'RuntimeError') return true
  return name === 'RangeError' && typeof message === 'string' && /call stack/i.test(message)
}

/** Whether `err` is one a caller gets for an instance that was reset or could not be. */
export function isRecoveryError(err: unknown): boolean {
  return err instanceof CoreInstanceTrapped || err instanceof CoreUnrecoverable
}

class Instance {
  generation = 0
  log: RecoveryLog | undefined
  #unrecoverable: CoreUnrecoverable | undefined

  constructor(
    private readonly glue: ResettableGlue,
    private readonly abi: string,
  ) {}

  /** `call`, with a trap in it answered by a reset and a typed refusal. */
  guard<T>(operation: string, call: () => T): T {
    if (this.#unrecoverable !== undefined) throw new CoreUnrecoverable(operation)
    try {
      return call()
    } catch (err) {
      if (!isInstanceTrap(err)) throw err
      throw this.#recover(operation, err)
    }
  }

  #recover(operation: string, trap: unknown): Error {
    // The old handles are void whether or not the reset works.
    this.generation += 1
    try {
      this.log?.error(
        { operation, generation: this.generation },
        'wasm instance trapped; resetting',
      )
    } catch {
      // a logger that throws must not turn a recovery into a second failure
    }
    let last: unknown
    for (let attempt = 0; attempt < MAX_RESET_ATTEMPTS; attempt++) {
      try {
        this.glue.__wbg_reset_state()
        if (this.glue.abi_version() === this.abi) {
          return new CoreInstanceTrapped(operation, this.generation, { cause: trap })
        }
        last = new Error('the reset instance answers another ABI')
      } catch (err) {
        last = err
      }
    }
    this.#unrecoverable = new CoreUnrecoverable(operation, { cause: last })
    return this.#unrecoverable
  }
}

const INSTANCES = new WeakMap<object, Instance>()
const BY_GUARDED = new WeakMap<object, Instance>()
const GUARDED = new WeakMap<object, object>()

/** Exports recovery leaves unwrapped: init, the ABI probe and the reset itself. */
const UNGUARDED = new Set(['default', 'initSync', 'abi_version', '__wbg_reset_state'])

/**
 * `glue` with every export call guarded, one per glue however many cores are
 * built over it: wasm-bindgen's `initSync` answers the instance it already
 * holds, so every core over one glue shares one instance and one generation.
 * `abi` is what a reset instance must still report.
 */
export function recoverable<G extends ResettableGlue>(glue: G, abi: string, log?: RecoveryLog): G {
  let instance = INSTANCES.get(glue)
  if (instance === undefined) {
    instance = new Instance(glue, abi)
    INSTANCES.set(glue, instance)
  }
  if (log !== undefined) instance.log = log
  const held = GUARDED.get(glue)
  if (held !== undefined) return held as G
  const guarded: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(glue)) {
    guarded[name] =
      typeof value === 'function' && !UNGUARDED.has(name)
        ? (...args: unknown[]) =>
            instance.guard(name, () => (value as (...a: unknown[]) => unknown)(...args))
        : value
  }
  GUARDED.set(glue, guarded)
  BY_GUARDED.set(guarded, instance)
  return guarded as G
}

/** The generation of the instance behind `glue`: 0 for glue that is not recoverable's. */
export function generationOf(glue: object): number {
  return BY_GUARDED.get(glue)?.generation ?? 0
}

/** Refuses a handle minted in an earlier generation than `glue`'s current one. */
export function assertLive(glue: object, generation: number, operation: string): void {
  if (generation !== generationOf(glue)) throw new CoreHandleLost(operation)
}

/**
 * The finalizer for the current generation's handles. A finalizer a later
 * generation inherits would release a number that now names something live,
 * so each generation has its own, whose releases are dropped once it is past.
 */
export function finalizerPerGeneration(
  glue: object,
  make: (release: (handle: number) => void) => Finalizer,
  release: (handle: number) => void,
): () => Finalizer {
  let current: { generation: number; finalizer: Finalizer } | undefined
  return () => {
    const generation = generationOf(glue)
    if (current?.generation !== generation) {
      current = {
        generation,
        finalizer: make((handle) => {
          if (generationOf(glue) === generation) release(handle)
        }),
      }
    }
    return current.finalizer
  }
}
