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
const coreImplSchema = z.enum(['ts', 'differential', 'rust'])

const coreSettingsSchema = z.object({
  impl: coreImplSchema,
  /**
   * The whole layout's own switch (`VITE_WHITEBOARD_CORE_LAYOUT`, the
   * daemon's `WHITEBOARD_CORE_LAYOUT`): the core lays a canvas out measuring
   * through the page's own measurer, asked mid-layout. Unset, it follows
   * routing: `rust` in a production build (ADR-0054 step 7, S16b),
   * `differential` in the dev server and wherever a test job sets routing
   * so, `ts` in a test run otherwise. `ts` is the rollback. It needs a
   * loaded core, so under `impl: 'ts'` it compares nothing whatever it reads.
   */
  layout: coreImplSchema,
  mismatch: z.enum(['log', 'throw']),
})
export type CoreSettings = z.infer<typeof coreSettingsSchema>

interface CoreEnv {
  readonly VITE_WHITEBOARD_CORE?: string
  readonly VITE_WHITEBOARD_CORE_LAYOUT?: string
  readonly VITE_WHITEBOARD_CORE_MISMATCH?: string
  readonly DEV?: boolean
  readonly MODE?: string
}

export function coreSettingsFrom(env: CoreEnv): CoreSettings {
  const devDefault = env.MODE === 'test' ? 'ts' : env.DEV === true ? 'differential' : 'rust'
  const impl = coreImplSchema.parse(env.VITE_WHITEBOARD_CORE || devDefault)
  return coreSettingsSchema.parse({
    impl,
    layout: env.VITE_WHITEBOARD_CORE_LAYOUT || impl,
    mismatch: env.VITE_WHITEBOARD_CORE_MISMATCH || 'log',
  })
}
