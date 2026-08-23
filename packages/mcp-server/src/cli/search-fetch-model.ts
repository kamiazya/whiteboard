// `whiteboard search fetch-model` — the one step that turns
// WHITEBOARD_SEMANTIC_SEARCH=1 from an opt-in flag into a working feature.
//
// It lives in the CLI rather than in scripts/ because scripts/ is not
// published: the repo-only `pnpm --filter … search:fetch-model` was the ONLY
// way to populate the cache, so an installed user could set the flag, see
// search keep working, and never learn that the half they turned on had
// silently not engaged.

import {
  classifyEmbedderLoadFailure,
  DEFAULT_MODEL,
  EMBEDDER_LOAD_REMEDY,
  EMBEDDING_DIMENSIONS,
  type EmbedderLoadFailure,
  loadEmbeddingPipeline,
} from '../server/search/transformers-embedder.js'
import { redactDiagnosticText } from '../shared/diagnostics/redact.js'

export interface SearchFetchModelOptions {
  /** Where weights are written. The daemon reads the same directory. */
  cacheDir: string
  model?: string
}

export type SearchFetchModelResult =
  | {
      ok: true
      cacheDir: string
      model: string
      dimensions: number
      elapsedMs: number
    }
  | {
      ok: false
      cacheDir: string
      model: string
      failure: EmbedderLoadFailure | 'unexpected-dimensions'
      remedy: string
      /**
       * The underlying message, redacted. `load-failed` is the bucket for
       * everything the classifier could not name — a blocked proxy, a
       * corrupt download, an onnx init fault — and a remedy alone reduces
       * all of them to "it failed", which is precisely the unhelpfulness
       * this command exists to end. Present only when there is something to
       * say beyond the remedy.
       */
      detail?: string
    }

const UNEXPECTED_DIMENSIONS_REMEDY =
  'the model loaded but produced vectors of the wrong width — the cache may be from a different model; delete it and re-run'

/**
 * Verifies by USE, not by the presence of files: the download is only worth
 * reporting as done if an embedding actually comes back at the width the
 * search index is built for. A half-written cache otherwise reports success
 * here and degrades to lexical at the daemon, which is the failure mode this
 * whole command exists to make visible.
 */
export async function runSearchFetchModel(
  options: SearchFetchModelOptions,
): Promise<{ result: SearchFetchModelResult; exitCode: number }> {
  const model = options.model ?? DEFAULT_MODEL
  const startedAt = Date.now()

  let extractor: Awaited<ReturnType<typeof loadEmbeddingPipeline>>
  try {
    // Deliberately NOT offline: this command is the download.
    extractor = await loadEmbeddingPipeline({ cacheDir: options.cacheDir, model })
  } catch (err) {
    const failure = classifyEmbedderLoadFailure(err)
    const raw = err instanceof Error ? err.message : String(err)
    return {
      result: {
        ok: false,
        cacheDir: options.cacheDir,
        model,
        failure,
        remedy: EMBEDDER_LOAD_REMEDY[failure],
        // Paths and tokens can appear in a transformers.js or undici message,
        // and this object is printed to stdout for a user to paste into a bug
        // report. Run it through the same redactor the daemon's diagnostics
        // use rather than trusting the upstream string.
        detail: redactDiagnosticText(raw.split('\n')[0] ?? raw),
      },
      exitCode: 1,
    }
  }

  const output = await extractor(['passage: warm the model'], {
    pooling: 'mean',
    normalize: true,
  })

  if (output.data.length !== EMBEDDING_DIMENSIONS) {
    return {
      result: {
        ok: false,
        cacheDir: options.cacheDir,
        model,
        failure: 'unexpected-dimensions',
        remedy: UNEXPECTED_DIMENSIONS_REMEDY,
      },
      exitCode: 1,
    }
  }

  return {
    result: {
      ok: true,
      cacheDir: options.cacheDir,
      model,
      dimensions: EMBEDDING_DIMENSIONS,
      elapsedMs: Date.now() - startedAt,
    },
    exitCode: 0,
  }
}
