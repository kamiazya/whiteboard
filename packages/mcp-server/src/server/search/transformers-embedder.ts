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
const DEFAULT_MODEL = 'Xenova/multilingual-e5-small'

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
export function createTransformersEmbedder(options: TransformersEmbedderOptions): Embedder {
  const model = options.model ?? DEFAULT_MODEL
  let pipe: Promise<ExtractorLike> | undefined
  let broken = false

  const load = async (): Promise<ExtractorLike> => {
    const { pipeline, env } = await import('@huggingface/transformers')
    env.cacheDir = options.cacheDir
    log.info({ model, dtype: options.dtype ?? DEFAULT_DTYPE }, 'loading embedding model')
    return (await pipeline('feature-extraction', model, {
      dtype: options.dtype ?? DEFAULT_DTYPE,
    })) as unknown as ExtractorLike
  }

  return {
    // multilingual-e5-small. Wrong here means every vector is rejected by
    // the shape check rather than silently mis-scored.
    dimensions: 384,
    async embed(texts, role) {
      if (broken || texts.length === 0) return []
      pipe ??= load()
      let extractor: ExtractorLike
      try {
        extractor = await pipe
      } catch (err) {
        broken = true
        pipe = undefined
        log.warning({ model, err }, 'embedding model unavailable, search stays lexical')
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
