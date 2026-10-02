// `whiteboard search fetch-model` — the one step that turns
// WHITEBOARD_SEMANTIC_SEARCH=1 from an opt-in flag into a working feature.
//
// It lives in the CLI rather than in scripts/ because scripts/ is not
// published: the repo-only `pnpm --filter … search:fetch-model` was the ONLY
// way to populate the cache, so an installed user could set the flag, see
// search keep working, and never learn that the half they turned on had
// silently not engaged.

import { messageOf } from '@kamiazya/whiteboard-model'
import {
  classifyEmbedderLoadFailure,
  DEFAULT_MODEL,
  EMBEDDER_LOAD_REMEDY,
  EMBEDDING_DIMENSIONS,
  loadEmbeddingPipeline,
} from '../server/search/transformers-embedder.js'
import type { SearchFetchModelOutput } from '../shared/api-contracts/search-fetch-model.js'
import { redactDiagnosticText } from '../shared/diagnostics/redact.js'
import { OPERATOR_JSON_SCHEMA_VERSION } from './operator-json.js'

export interface SearchFetchModelOptions {
  /** Where weights are written. The daemon reads the same directory. */
  cacheDir: string
  /**
   * Fetch what the daemon will actually load. Downloading q8 and then
   * running `WHITEBOARD_SEMANTIC_SEARCH=full` would leave the first search
   * reaching for weights that are not there — and the daemon is offline by
   * design, so it would stay lexical rather than say why.
   */
  dtype?: 'q8' | 'fp32'
  model?: string
}

export type SearchFetchModelResult = SearchFetchModelOutput

const UNEXPECTED_DIMENSIONS_REMEDY =
  'the model loaded but produced vectors of the wrong width — the cache may be from a different model; delete it and re-run'

/** What every outcome says about the fetch it describes. */
function fetchTarget(options: SearchFetchModelOptions) {
  return {
    schemaVersion: OPERATOR_JSON_SCHEMA_VERSION,
    cacheDir: options.cacheDir,
    model: options.model ?? DEFAULT_MODEL,
    dtype: options.dtype ?? 'q8',
  }
}

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
  const target = fetchTarget(options)
  const { model, dtype } = target
  const startedAt = Date.now()

  let extractor: Awaited<ReturnType<typeof loadEmbeddingPipeline>>
  try {
    // Deliberately NOT offline: this command is the download.
    extractor = await loadEmbeddingPipeline({ cacheDir: options.cacheDir, model, dtype })
  } catch (err) {
    const failure = classifyEmbedderLoadFailure(err)
    const raw = messageOf(err, String(err))
    return {
      result: {
        ...target,
        kind: 'failed',
        ok: false,
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
        ...target,
        kind: 'failed',
        ok: false,
        failure: 'unexpected-dimensions',
        remedy: UNEXPECTED_DIMENSIONS_REMEDY,
      },
      exitCode: 1,
    }
  }

  return {
    result: {
      ...target,
      kind: 'ok',
      ok: true,
      dimensions: EMBEDDING_DIMENSIONS,
      elapsedMs: Date.now() - startedAt,
    },
    exitCode: 0,
  }
}
