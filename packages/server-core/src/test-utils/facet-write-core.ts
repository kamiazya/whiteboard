import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import type { FacetWriteCore } from '../facet-write-core.js'

/**
 * The facet-write core a test realm's deps carry when its environment says so
 * (`WHITEBOARD_CORE_FACETS`), so the whole server-core suite can run the
 * facet write in `differential` and fail on a difference
 * (`WHITEBOARD_CORE_MISMATCH=throw`). Absent under `ts`, which is what a run
 * with nothing set gets.
 */
export function facetWriteCoreFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): (() => Promise<FacetWriteCore>) | undefined {
  const impl = env.WHITEBOARD_CORE_FACETS
  if (impl === undefined || impl === '' || impl === 'ts') return undefined
  if (impl !== 'differential' && impl !== 'rust') {
    throw new Error(`WHITEBOARD_CORE_FACETS is ts, differential or rust, not "${impl}"`)
  }
  const throws = env.WHITEBOARD_CORE_MISMATCH === 'throw'
  let built: Promise<FacetWriteCore> | undefined
  return () => {
    built ??= (async () => {
      const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))
      const core = await loadCore(readFileSync(artifact))
      return {
        facets: core,
        impl: { partitionFacetWrites: impl },
        onMismatch: (mismatch) => {
          if (throws)
            throw new Error(`facet write core ${mismatch.kind}: ${JSON.stringify(mismatch)}`)
        },
      }
    })()
    return built
  }
}
