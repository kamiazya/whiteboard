import { z } from 'zod'

/**
 * How this app routes a canvas's edges (ADR-0054's `CoreImpl`), from the
 * build's environment: the web counterpart of the daemon's
 * `WHITEBOARD_CORE` / `WHITEBOARD_CORE_MISMATCH`. The dev server runs
 * `differential`; a production build is `rust`, so a release pays for no
 * second routing and its build requires the staged wasm
 * (`VITE_WHITEBOARD_CORE=ts` is the rollback and builds without it). A test
 * run stays on `ts` until its CI job sets `VITE_WHITEBOARD_CORE`, because a
 * jsdom page has no fetch to load the artifact with. `VITE_WHITEBOARD_CORE_MISMATCH=throw` fails the
 * layout that found a difference, which is what a test run wants.
 *
 * The OKF envelope (an imported Markdown file, a downloaded note, a note sent
 * to the daemon) and the JSON Canvas codec (an imported `.canvas` file, a
 * downloaded or copied board, an editable PNG's source) have no switch: their
 * TypeScript is deleted, so every build carries the wasm and the page awaits the
 * core before reading or writing either (`lib/codec-cores.ts`).
 *
 * An unknown value is refused rather than defaulted: a typo that fell back
 * to `ts` would compare nothing and read as a pass.
 */
const coreSettingsSchema = z.object({
  impl: z.enum(['ts', 'differential', 'rust']),
  mismatch: z.enum(['log', 'throw']),
})
export type CoreSettings = z.infer<typeof coreSettingsSchema>

interface CoreEnv {
  readonly VITE_WHITEBOARD_CORE?: string
  readonly VITE_WHITEBOARD_CORE_MISMATCH?: string
  readonly DEV?: boolean
  readonly MODE?: string
}

export function coreSettingsFrom(env: CoreEnv): CoreSettings {
  const devDefault = env.MODE === 'test' ? 'ts' : env.DEV === true ? 'differential' : 'rust'
  return coreSettingsSchema.parse({
    impl: env.VITE_WHITEBOARD_CORE || devDefault,
    mismatch: env.VITE_WHITEBOARD_CORE_MISMATCH || 'log',
  })
}
