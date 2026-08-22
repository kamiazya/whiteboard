import { join } from 'node:path'
import type { Embedder } from '@kamiazya/whiteboard-server-core'
import { getDataDir } from '../config.js'
import { createTransformersEmbedder } from './transformers-embedder.js'

/**
 * The opt-in that turns document search from lexical-only into lexical
 * fused with semantic.
 *
 * OFF by default, and that is the decision rather than an oversight
 * (ADR-0015): turning it on costs a 113MB one-time model download, which
 * only a user who wants the capability should pay. Absent, search behaves
 * exactly as it has since stage 0 and nothing is fetched.
 *
 * Exactly `'1'` opts in — matching WHITEBOARD_DEBUG rather than accepting a
 * spread of truthy spellings, so `=0` cannot silently mean yes.
 */
const FLAG = 'WHITEBOARD_SEMANTIC_SEARCH'

export function resolveSearchEmbedder(): Embedder | undefined {
  if (process.env[FLAG] !== '1') return undefined
  // Weights live beside the daemon's other data, not inside node_modules:
  // a reinstall or a store prune must not silently cost another 113MB.
  return createTransformersEmbedder({ cacheDir: join(getDataDir(), 'models') })
}
