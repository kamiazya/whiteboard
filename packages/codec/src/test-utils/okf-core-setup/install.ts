import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Core } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import { installOkfCore } from '../../okf/okf-core.js'

const loaded = new Map<string, Promise<Core>>()

/**
 * Installs the Rust core as this test realm's OKF codec, from the staged
 * artifact. There is no TypeScript to fall back to, so a realm that cannot
 * install fails its whole file, naming the build step: a test that reached
 * OKF without the core would otherwise fail somewhere far from the cause.
 * One instance per artifact path, so a test that uninstalls the core to
 * observe the failure reinstalls it for the next.
 * `artifact` is overridable only so the failure can be tested.
 */
export async function installOkfCoreForTests(
  artifact: string = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm')),
): Promise<void> {
  if (!existsSync(artifact)) {
    throw new Error(
      `The Rust core's wasm artifact is missing at ${artifact}; OKF has no TypeScript implementation, so every test realm that reaches it needs the artifact. Run \`pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm\` (needs the Rust toolchain; CI restores it from a cache)`,
    )
  }
  let core = loaded.get(artifact)
  if (core === undefined) {
    core = loadCore(readFileSync(artifact))
    loaded.set(artifact, core)
  }
  installOkfCore(await core)
}
