import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import type { OkfImpl, OkfMismatch } from '../../okf/okf-core.js'
import { installOkfCore } from '../../okf/okf-core.js'

/** The two switches a test realm reads, as raw environment values. */
export interface OkfCoreEnv {
  readonly okf: string | undefined
  readonly mismatch: string | undefined
}

const IMPLS: readonly OkfImpl[] = ['ts', 'differential', 'rust']

/** The switch as written, `ts` when unset; a value outside the three is refused, since a typo that fell back to `ts` would compare nothing. */
function implOf(raw: string | undefined): OkfImpl {
  if (raw === undefined || raw === '') return 'ts'
  const impl = IMPLS.find((candidate) => candidate === raw)
  if (impl === undefined)
    throw new Error(`OKF core switch: ${JSON.stringify(raw)} is not ts, differential or rust`)
  return impl
}

/** A difference or decline fails the call that caused it under `throw`, else it is a warning. */
function reporter(mismatch: 'log' | 'throw') {
  return (found: OkfMismatch): void => {
    const summary =
      found.kind === 'declined'
        ? {
            fn: found.fn,
            reason:
              found.err instanceof Error ? `${found.err.name}: ${found.err.message}` : 'unknown',
          }
        : { fn: found.fn, ts: found.ts, rust: found.rust }
    const message = `OKF core ${found.kind}: ${JSON.stringify(summary)}`
    if (mismatch === 'throw') throw new Error(message)
    console.warn(message)
  }
}

/**
 * Installs the Rust core as this test realm's OKF codec when its switch asks
 * for it, from the staged artifact. Unset or `ts` installs nothing, so a
 * contributor without the Rust toolchain keeps running the TypeScript. A
 * switch that asks for the core when the artifact is missing FAILS: CI must
 * never fall back to the TypeScript and read as having compared the two.
 * `artifact` is overridable only so the failure can be tested.
 */
export async function installOkfCoreForTests(
  env: OkfCoreEnv,
  artifact: string = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm')),
): Promise<void> {
  const impl = implOf(env.okf)
  if (impl === 'ts') return
  if (
    env.mismatch !== undefined &&
    env.mismatch !== '' &&
    env.mismatch !== 'log' &&
    env.mismatch !== 'throw'
  ) {
    throw new Error(`OKF core mismatch mode: ${JSON.stringify(env.mismatch)} is not log or throw`)
  }
  if (!existsSync(artifact)) {
    throw new Error(
      `The OKF core switch reads ${impl} but the wasm artifact is missing at ${artifact}; run \`pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm\`, or unset the switch to run the TypeScript alone`,
    )
  }
  const core = await loadCore(readFileSync(artifact))
  installOkfCore({
    okf: core,
    impl: { parseOkf: impl, serializeOkf: impl },
    onMismatch: reporter(env.mismatch === 'throw' ? 'throw' : 'log'),
  })
}
