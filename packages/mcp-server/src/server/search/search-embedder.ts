import { join } from 'node:path'
import type { Embedder } from '@kamiazya/whiteboard-server-core'
import { getDataDir } from '../config.js'
import { createTransformersEmbedder } from './transformers-embedder.js'

/**
 * The opt-in that turns document search from lexical-only into lexical
 * fused with semantic.
 *
 * OFF by default, and that is the decision rather than an oversight
 * (ADR-0015): the model is ~113MB, and only a user who wants the capability
 * should pay for it. Absent, search behaves exactly as it has since stage 0.
 *
 * Exactly `'1'` opts in — matching WHITEBOARD_DEBUG rather than accepting a
 * spread of truthy spellings, so `=0` cannot silently mean yes.
 */
const FLAG = 'WHITEBOARD_SEMANTIC_SEARCH'

let held: Embedder | undefined

/**
 * Memoized for the life of the process, and that is load-bearing rather
 * than a micro-optimisation: `/mcp` is stateless per request, so the MCP
 * server — and with it every `ServerDeps` — is rebuilt for each call. A
 * per-call embedder re-loads the whole model on every single search.
 *
 * Weights are read from the daemon's own data directory and never fetched
 * here. A download does not belong on a request path at any size, let alone
 * this one; `pnpm --filter @kamiazya/whiteboard-mcp search:fetch-model`
 * populates the cache as a deliberate step, and until it has, search simply
 * stays lexical.
 */
export function resolveSearchEmbedder(): Embedder | undefined {
  if (process.env[FLAG] !== '1') return undefined
  held ??= createTransformersEmbedder({ cacheDir: searchModelCacheDir(), offline: true })
  return held
}

/**
 * Beside the daemon's other data rather than inside node_modules, which is
 * where transformers.js would otherwise put it — under pnpm that is the
 * shared content-addressed store, a location `pnpm store prune` empties and
 * every project on the machine shares.
 */
export function searchModelCacheDir(): string {
  return join(getDataDir(), 'models')
}

export function resetSearchEmbedderForTests(): void {
  held = undefined
}
