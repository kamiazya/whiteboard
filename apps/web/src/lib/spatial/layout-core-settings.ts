import { z } from 'zod'

/**
 * How this app routes a canvas's edges (ADR-0054's `CoreImpl`), from the
 * build's environment: the web counterpart of the daemon's
 * `WHITEBOARD_CORE` / `WHITEBOARD_CORE_MISMATCH`. The dev server runs
 * `differential`; a production build is `ts`, so a release pays for no
 * second routing (it still carries the wasm, unused until this default moves). A test run stays on `ts` until its
 * CI job sets `VITE_WHITEBOARD_CORE`, because a jsdom page has no fetch to
 * load the artifact with. `VITE_WHITEBOARD_CORE_MISMATCH=throw` fails the
 * layout that found a difference, which is what a test run wants.
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
  const devDefault = env.DEV === true && env.MODE !== 'test' ? 'differential' : 'ts'
  return coreSettingsSchema.parse({
    impl: env.VITE_WHITEBOARD_CORE || devDefault,
    mismatch: env.VITE_WHITEBOARD_CORE_MISMATCH || 'log',
  })
}
