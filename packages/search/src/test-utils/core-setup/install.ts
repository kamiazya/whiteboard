import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Core } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import { installSearchCore } from '../../core.js'

const loaded = new Map<string, Promise<Core>>()

/**
 * Installs the Rust core's search as this test realm's search, from the staged
 * artifact. Search has no TypeScript to fall back to, so a realm that cannot
 * install fails its whole file naming the build step: a test that reached
 * search without the core would otherwise fail somewhere far from the cause.
 * One instance per artifact path; `artifact` is overridable only so the
 * failure can be tested.
 */
export async function installSearchCoreForTests(
  artifact: string = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm')),
): Promise<void> {
  if (!existsSync(artifact)) {
    throw new Error(
      `The Rust core's wasm artifact is missing at ${artifact}; lexical search has no TypeScript implementation, so every test realm that reaches it needs the artifact. Run \`pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm\` (needs the Rust toolchain; CI restores it from a cache)`,
    )
  }
  let core = loaded.get(artifact)
  if (core === undefined) {
    core = loadCore(readFileSync(artifact))
    loaded.set(artifact, core)
  }
  installSearchCore((await core).search)
}
