/**
 * Whether this run's pipeline asked for a loaded Rust core, so a test that
 * finds none fails instead of skipping.
 *
 * Only `differential` and `rust` load one: under `VITE_WHITEBOARD_CORE=ts`
 * the host answers in TypeScript and loads nothing (`createLayoutCoreHost`'s
 * `start` in `lib/spatial/layout-core.ts`), which is a valid run, not a
 * missing artifact. Unset is a test run's own default, `ts`. Read off the env
 * here rather than through `coreSettingsFrom`, so a test does not take its
 * expectation from the code that decides what to load.
 */
const IMPLS_THAT_LOAD_A_CORE: readonly string[] = ['differential', 'rust']

export const CORE_REQUIRED = IMPLS_THAT_LOAD_A_CORE.includes(
  import.meta.env.VITE_WHITEBOARD_CORE ?? '',
)
