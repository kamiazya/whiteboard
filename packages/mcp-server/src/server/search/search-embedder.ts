import type { Embedder } from '@kamiazya/whiteboard-server-core'
import { searchModelCacheDir } from './model-cache-dir.js'
import { createTransformersEmbedder } from './transformers-embedder.js'

/**
 * The opt-in that turns document search from lexical-only into lexical
 * fused with semantic, and how good a job it should do.
 *
 * OFF by default, and that is the decision rather than an oversight
 * (ADR-0015): the model is ~113MB, and only a user who wants the capability
 * should pay for it. Absent, search behaves exactly as it has since stage 0.
 *
 * Two opt-in values, because the download and the quality are the same
 * dial and the reader is the one who knows which end they want:
 *
 * - `'1'` — quantised weights, 118MB. The default because opting in
 *   should not mean opting into half a gigabyte.
 * - `'full'` — full precision, 470MB. Scores 0.051 higher on JQaRA
 *   (95% CI [+0.024, +0.081], p = 0.0003) — about 11% relative, for four
 *   times the download.
 *
 * Nothing else opts in. A spread of truthy spellings would let `=0` mean
 * yes, and `'q8'`/`'fp32'` are rejected deliberately: the value says
 * whether to turn this on, and only then how well.
 */
const FLAG = 'WHITEBOARD_SEMANTIC_SEARCH'
const PRECISION = { '1': 'q8', full: 'fp32' } as const

// Per data directory, since the weights are read from the one the keeper serves.
const held = new Map<string, Embedder>()

/**
 * Memoized per data directory for the life of the process, and that is
 * load-bearing rather than a micro-optimisation: a `ServerDeps` is composed
 * per root, and the stdio root composes one per connection, so an embedder
 * held by the deps would re-load the whole model each time one is composed.
 *
 * Weights are read from the data directory the keeper serves (the caller's
 * `StoreScope`, never the process's) and never fetched here. A download does not belong on a request path at any size, let alone
 * this one; `whiteboard search fetch-model` populates the cache as a
 * deliberate step, and until it has, search simply stays lexical.
 */
export function resolveSearchEmbedder(dataDir: string): Embedder | undefined {
  const dtype = PRECISION[process.env[FLAG] as keyof typeof PRECISION]
  if (dtype === undefined) return undefined
  const existing = held.get(dataDir)
  if (existing !== undefined) return existing
  const created = createTransformersEmbedder({
    cacheDir: searchModelCacheDir(dataDir),
    offline: true,
    dtype,
  })
  held.set(dataDir, created)
  return created
}

export function resetSearchEmbedderForTests(): void {
  held.clear()
}
