import type { Embedder } from '@kamiazya/whiteboard-server-core'
import { getLogger } from '../log.js'

const log = getLogger('search-embedder')

/**
 * Default model: multilingual-e5-small, 384 dimensions, ~100 languages.
 *
 * Multilingual is the requirement, not a preference — an English-only model
 * is not a cheaper version of this feature, it is a different one that fails
 * silently on half of a bilingual corpus. Of the multilingual candidates the
 * research shortlisted, this is the only one published with ONNX weights,
 * which is what transformers.js can actually run.
 */
export const DEFAULT_MODEL = 'Xenova/multilingual-e5-small'

/**
 * multilingual-e5-small's width. Wrong here means every vector is rejected
 * by the port's shape check rather than silently mis-scored.
 */
export const EMBEDDING_DIMENSIONS = 384

/**
 * e5 is trained with these literal prefixes and loses accuracy without them.
 * https://huggingface.co/intfloat/multilingual-e5-small#faq
 */
const E5_PREFIX = { query: 'query: ', document: 'passage: ' } as const

/**
 * Quantised weights. The full-precision model is several times the size for
 * a difference the judged corpus has not been shown to notice — if a
 * measurement says otherwise, this is the knob.
 */
const DEFAULT_DTYPE = 'q8'

export interface TransformersEmbedderOptions {
  /**
   * Where the ~113MB of model weights are cached. REQUIRED, because
   * transformers.js otherwise writes them inside its own installed package
   * directory — which under pnpm is the shared content-addressed store, a
   * location `pnpm store prune` empties and every project on the machine
   * shares. The caller knows where its data lives; this file does not.
   */
  cacheDir: string
  /**
   * Refuse to fetch anything, serving only what `cacheDir` already holds.
   * The daemon sets this: a ~113MB download has no business on a request
   * path, and a search that would block on one should return lexical
   * results instead. The fetch script leaves it off.
   */
  offline?: boolean
  /** Hugging Face model id. */
  model?: string
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4'
}

/**
 * A local, offline-after-first-run embedder over transformers.js.
 *
 * The model is loaded lazily on the first embed and never at construction:
 * a daemon that starts must not pay a model download before it can answer
 * anything, and a workspace nobody searches should pay nothing at all.
 *
 * A load failure is remembered, not retried per query. Retrying a missing
 * or broken model on every keystroke turns one slow search into a permanently
 * slow one, and the caller already degrades to lexical results.
 */
/**
 * Why the load is separate from the embedder that uses it: the embedder's
 * contract is to degrade to lexical results, so it must swallow whatever
 * goes wrong here. The fetch command's contract is the opposite — it exists
 * to tell the user what went wrong — and both must exercise the same load,
 * or the diagnostic stops describing the thing it diagnoses.
 *
 * Throws. Callers classify with {@link classifyEmbedderLoadFailure}.
 */
export async function loadEmbeddingPipeline(
  options: TransformersEmbedderOptions,
): Promise<ExtractorLike> {
  const model = options.model ?? DEFAULT_MODEL
  const dtype = options.dtype ?? DEFAULT_DTYPE
  const { pipeline, env } = await import('@huggingface/transformers')
  env.cacheDir = options.cacheDir
  if (options.offline === true) env.allowRemoteModels = false
  log.info({ model, dtype }, 'loading embedding model')
  return (await pipeline('feature-extraction', model, { dtype })) as unknown as ExtractorLike
}

/**
 * The three ways loading fails need three different answers, and the one
 * that used to be logged for all of them ("unavailable") is actionable for
 * none. `runtime-missing` is a packaging state the user fixes by installing
 * the optional peer; `weights-missing` is fixed by running the fetch
 * command; anything else is a real fault worth reporting as one.
 */
export type EmbedderLoadFailure = 'runtime-missing' | 'weights-missing' | 'load-failed'

export function classifyEmbedderLoadFailure(err: unknown): EmbedderLoadFailure {
  const code = (err as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return 'runtime-missing'
  const message = err instanceof Error ? err.message : String(err)
  // transformers.js reports a cache miss under `allowRemoteModels = false`
  // by naming the file it could not produce; there is no error code to read.
  if (/could not locate file|no such file|unauthorized access to file/i.test(message)) {
    return 'weights-missing'
  }
  return 'load-failed'
}

/**
 * What to tell a user who opted in and got lexical results anyway. Keyed by
 * failure so the message names the ONE step that actually unblocks them.
 */
export const EMBEDDER_LOAD_REMEDY: Record<EmbedderLoadFailure, string> = {
  'runtime-missing':
    'semantic search needs the optional @huggingface/transformers runtime — install it beside the server',
  'weights-missing':
    'the embedding model has not been downloaded yet — run `whiteboard search fetch-model`',
  'load-failed': 'the embedding model failed to load',
}

export function createTransformersEmbedder(options: TransformersEmbedderOptions): Embedder {
  const model = options.model ?? DEFAULT_MODEL
  let pipe: Promise<ExtractorLike> | undefined
  let broken = false

  const dtype = options.dtype ?? DEFAULT_DTYPE
  return {
    // Model AND precision, because a cached vector is only comparable to
    // one made the same way — q8 and fp32 of this model are both 384-wide
    // and measurably different.
    id: `${model}@${dtype}`,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts, role) {
      if (broken || texts.length === 0) return []
      pipe ??= loadEmbeddingPipeline(options)
      let extractor: ExtractorLike
      try {
        extractor = await pipe
      } catch (err) {
        broken = true
        pipe = undefined
        const failure = classifyEmbedderLoadFailure(err)
        log.warning(
          { model, failure, err },
          `search stays lexical: ${EMBEDDER_LOAD_REMEDY[failure]}`,
        )
        return []
      }
      // pooling+normalize in the runtime rather than in JS: the port's
      // contract is unit vectors, and doing it here keeps a whole tensor
      // round trip out of the event loop.
      const prefix = E5_PREFIX[role]
      const output = await extractor(
        texts.map((text) => `${prefix}${text}`),
        { pooling: 'mean', normalize: true },
      )
      const flat = output.data
      const width = flat.length / texts.length
      return texts.map((_, index) =>
        Float32Array.from(flat.slice(index * width, (index + 1) * width)),
      )
    },
  }
}

/** The narrow slice of transformers.js's pipeline this file relies on. */
type ExtractorLike = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array | number[] }>
