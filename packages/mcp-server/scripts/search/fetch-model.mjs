/**
 * Downloads the semantic-search model into the daemon's data directory.
 *
 * A deliberate step rather than something a search does for you. The
 * weights are ~113MB; fetching them on a request path would make one
 * user's first search block on a download, and `/mcp` being stateless per
 * request means that path is entered far more often than "once". The
 * daemon therefore runs strictly offline and simply stays lexical until
 * this script has run.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp search:fetch-model
 *
 * Idempotent: an already-populated cache re-verifies and exits.
 */
import { searchModelCacheDir } from '../../src/server/search/search-embedder.ts'
import { createTransformersEmbedder } from '../../src/server/search/transformers-embedder.ts'

const cacheDir = searchModelCacheDir()
process.stdout.write(`fetching the search model into ${cacheDir}\n`)

const embedder = createTransformersEmbedder({ cacheDir })
const startedAt = Date.now()
const [vector] = await embedder.embed(['warm the model'], 'document')

if (vector === undefined || vector.length !== embedder.dimensions) {
  process.stderr.write('the model did not load; search will stay lexical\n')
  process.exit(1)
}

process.stdout.write(
  `ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ` +
    'set WHITEBOARD_SEMANTIC_SEARCH=1 to use it\n',
)
