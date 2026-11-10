/**
 * The spatial tests layer 1 runs against the TypeScript instead of the Rust
 * core, each because it replaces a module INSIDE the TypeScript implementation
 * and so can only be answered by that implementation. They are not tolerated
 * differences: the core answers the same input in the same way, and the live
 * differential and the native strict-mode examples hold it to that. A test
 * here is run, not skipped, with the shim delegating to the TypeScript.
 *
 * `spatial-layer-one.rust.test.ts` fails on a title no spatial test carries any
 * more, and on one whose test no longer replaces the module it names, so an
 * entry cannot outlive the test it names.
 */
export const TYPESCRIPT_ONLY_TESTS: readonly {
  readonly file: string
  readonly title: string
  /** The module the test replaces, as its source spells it. */
  readonly replaces: string
}[] = [
  {
    file: 'serialize.test.ts',
    title: 'strict mode re-validates the degraded document and throws if it is not schema-valid',
    replaces: "vi.doMock('./degrade.js'",
  },
]

/**
 * Whether the test running now is one of them; set by `setup.ts`. Held on
 * `globalThis` because such a test resets the module registry, which would
 * hand the shim a second copy of this module that `setup.ts` never set.
 */
const holder = globalThis as { __spatialWasmRunning?: { typescriptOnly: boolean } }
holder.__spatialWasmRunning ??= { typescriptOnly: false }
export const running: { typescriptOnly: boolean } = holder.__spatialWasmRunning
