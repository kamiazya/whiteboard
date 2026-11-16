import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Core } from '@kamiazya/whiteboard-core-wasm'
import { loadCore } from '@kamiazya/whiteboard-core-wasm/load'
import type { LayoutCore } from '../layout/edges/layout-core.js'

/**
 * The Rust core a Node-hosted test hands a layout, loaded from the staged
 * SHIPPED artifact (`packages/core-wasm/artifacts`) — the one every root
 * loads. There is no TypeScript layout to answer in its place (ADR-0054 step
 * 7, S18h), so a realm without the artifact fails its file here, naming the
 * build step, rather than at its first layout. One instance per test file.
 *
 * Node-only (it reads the artifact with `node:fs`), so it is published as
 * its own subpath, `./test-utils/node-core`, and never reaches a browser
 * test through `./test-utils`.
 */
const artifact = fileURLToPath(import.meta.resolve('@kamiazya/whiteboard-core-wasm/wasm'))

let loaded: Promise<Core> | undefined

/** The loaded core itself, for a realm that installs it elsewhere too (a host's loader). */
export function testCore(): Promise<Core> {
  if (!existsSync(artifact)) {
    throw new Error(
      `The Rust core's wasm artifact is missing at ${artifact}; every layout is answered by the core, so every test realm that lays out needs it. Run \`pnpm --filter @kamiazya/whiteboard-core-wasm build:wasm\` (needs the Rust toolchain; CI restores it from a cache)`,
    )
  }
  loaded ??= loadCore(readFileSync(artifact))
  return loaded
}

const asLayoutCore = (core: Core): LayoutCore => ({
  routing: core,
  layout: core,
  markdown: core,
  query: core,
})

const instance = asLayoutCore(await testCore())

/** The core every entry of a layout is answered by, as a root hands it. */
export const testLayoutCore = (): LayoutCore => instance
