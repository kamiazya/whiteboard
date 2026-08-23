/**
 * Repo-side alias for `whiteboard search fetch-model`.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp search:fetch-model [--full]
 *
 * The command itself lives in src/cli so it ships in dist — an installed
 * user cannot run anything under scripts/. This file exists only so a
 * contributor working from source does not have to build first.
 */
import { runSearchFetchModel } from '../../src/cli/search-fetch-model.ts'
import { getDataDir } from '../../src/server/config.ts'
import { searchModelCacheDir } from '../../src/server/search/model-cache-dir.ts'

const cacheDir = searchModelCacheDir(getDataDir())
const full = process.argv.includes('--full') || process.env.WHITEBOARD_SEMANTIC_SEARCH === 'full'
const dtype = full ? 'fp32' : 'q8'
process.stdout.write(
  `fetching the search model (${dtype}, ${full ? '~470MB' : '~118MB'}) into ${cacheDir}\n`,
)

const { result, exitCode } = await runSearchFetchModel({ cacheDir, dtype })
process.stdout.write(
  result.ok
    ? `ready in ${(result.elapsedMs / 1000).toFixed(1)}s — ` +
        `set WHITEBOARD_SEMANTIC_SEARCH=${full ? 'full' : '1'} to use it\n`
    : `${result.remedy}\n`,
)
process.exit(exitCode)
