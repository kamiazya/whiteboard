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
 * `VITE_WHITEBOARD_CORE_OKF` is the same switch for the OKF envelope (an
 * imported Markdown file, a downloaded note, a note sent to the daemon). It
 * defaults exactly as routing does: `rust` in a production build
 * (`VITE_WHITEBOARD_CORE_OKF=ts` is the rollback), `differential` in the dev
 * server, `ts` in a test run.
 *
 * An unknown value is refused rather than defaulted: a typo that fell back
 * to `ts` would compare nothing and read as a pass.
 */
const coreSettingsSchema = z.object({
  impl: z.enum(['ts', 'differential', 'rust']),
  okf: z.enum(['ts', 'differential', 'rust']),
  mismatch: z.enum(['log', 'throw']),
})
export type CoreSettings = z.infer<typeof coreSettingsSchema>

interface CoreEnv {
  readonly VITE_WHITEBOARD_CORE?: string
  readonly VITE_WHITEBOARD_CORE_OKF?: string
  readonly VITE_WHITEBOARD_CORE_MISMATCH?: string
  readonly DEV?: boolean
  readonly MODE?: string
}

export function coreSettingsFrom(env: CoreEnv): CoreSettings {
  const devDefault = env.MODE === 'test' ? 'ts' : env.DEV === true ? 'differential' : 'rust'
  return coreSettingsSchema.parse({
    impl: env.VITE_WHITEBOARD_CORE || devDefault,
    okf: env.VITE_WHITEBOARD_CORE_OKF || devDefault,
    mismatch: env.VITE_WHITEBOARD_CORE_MISMATCH || 'log',
  })
}
