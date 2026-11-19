/**
 * What the Rust core's shim throws once its wasm instance trapped
 * (`@kamiazya/whiteboard-core-wasm`'s `recover.ts`): the call that trapped, a
 * handle minted before the reset, and an instance that could not be reset.
 * Matched by name, as the shim's refusals are elsewhere in this app: the page
 * and every layout worker load their own copy of the shim, and importing it
 * here would carry it into modules that run before the core loads.
 */
const TRAP_NAMES: ReadonlySet<string> = new Set([
  'CoreInstanceTrapped',
  'CoreHandleLost',
  'CoreUnrecoverable',
])

/** Whether `err` says the core's instance was reset (or could not be), so that call has no answer. */
export function isCoreTrap(err: unknown): boolean {
  return err instanceof Error && TRAP_NAMES.has(err.name)
}

/** Whether `err` says the instance could not be reset: every later call in this realm is refused. */
export function isCoreUnrecoverable(err: unknown): boolean {
  return err instanceof Error && err.name === 'CoreUnrecoverable'
}
