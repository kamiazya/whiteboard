import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import { installFacetWriteCore } from '../facet-write-core.js'

/**
 * Installs the Rust core as this test realm's facet write, from the staged
 * artifact. The facet write has no TypeScript implementation in a daemon
 * realm, so a realm that cannot install fails its whole file, naming the build
 * step: a test that reached a facet write without the core would otherwise
 * fail somewhere far from the cause.
 */
export async function installFacetWriteCoreForTests(
  artifact: string = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm')),
): Promise<void> {
  if (!existsSync(artifact)) {
    throw new Error(
      `The Rust core's wasm artifact is missing at ${artifact}; the facet write has no TypeScript implementation in a daemon realm, so every test realm that reaches one needs the artifact. Run \`pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm\` (needs the Rust toolchain; CI restores it from a cache)`,
    )
  }
  installFacetWriteCore(await loadCore(readFileSync(artifact)))
}
