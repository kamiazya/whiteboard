import { join } from 'node:path'

/**
 * Beside the daemon's other data rather than inside node_modules, which is
 * where transformers.js would otherwise put it — under pnpm that is the
 * shared content-addressed store, a location `pnpm store prune` empties and
 * every project on the machine shares.
 *
 * Takes the data dir rather than reading it, so the CLI's `search
 * fetch-model` can name this one definition without importing
 * `server/config`, which mkdirs on load. The daemon and the fetch command
 * MUST agree on this path or the command downloads into a directory the
 * daemon never looks in.
 */
export function searchModelCacheDir(dataDir: string): string {
  return join(dataDir, 'models')
}
