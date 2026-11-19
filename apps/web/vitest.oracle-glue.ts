import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * The oracle artifact's glue and wasm bytes, for a `*.rust.test.ts` that needs
 * the instance itself (to trap it on purpose). Outside `src/` because it reads
 * the artifact with `node:*`, which the browser app's source may not import
 * (`web-app-boundary.test.ts`). `WHITEBOARD_WASM_DIR` is set by
 * `vitest.rust.config.ts`; a missing artifact fails naming the build step.
 */
export async function loadOracleGlue<G>(): Promise<{ glue: G; wasm: Buffer }> {
  const dir = process.env.WHITEBOARD_WASM_DIR ?? ''
  try {
    const glue = (await import(
      /* @vite-ignore */ pathToFileURL(join(dir, 'whiteboard_wasm.js')).href
    )) as G
    return { glue, wasm: readFileSync(join(dir, 'whiteboard_wasm_bg.wasm')) }
  } catch (cause) {
    throw new Error(`no oracle wasm artifact in ${dir}; run \`pnpm rust:build:wasm:oracle\``, {
      cause,
    })
  }
}
