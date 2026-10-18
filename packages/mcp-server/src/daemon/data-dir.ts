import { resolve } from 'node:path'
import {
  type DataDirTrust,
  homeDataDirIsUsable,
  resolveDataDir,
} from '../shared/data-dir-secure.js'

export interface DataDirOptions {
  checkWritable?: (path: string) => boolean
  homeDir?: string
  tmpDir?: string
}

/**
 * The data dir a command that does not start a root reads, decided exactly
 * as `resolveDataDir` decides it for the roots that do, but without creating
 * the home candidate.
 */
export function resolveDefaultDataDir(
  env: Record<string, string | undefined>,
  options?: DataDirOptions,
): string {
  return resolveDataDir(env, {
    homeDir: options?.homeDir,
    tmpDir: options?.tmpDir,
    isWritableDir: options?.checkWritable ?? homeDataDirIsUsable,
  })
}

/**
 * Where a `server *` command works, and whose judgement that dir gets. A dir
 * the operator named — a flag or `WHITEBOARD_DATA_DIR`, as a container sets
 * it — is the operator's (see `DataDirTrust`); the default nobody named is
 * this user's own, held to what the local daemon's dir is.
 */
export function serverModeDataDir(
  named: string | undefined,
  env: Record<string, string | undefined>,
): { dataDir: string; dataDirTrust: DataDirTrust } {
  if (named !== undefined) return { dataDir: resolve(named), dataDirTrust: 'operator' }
  if (env.WHITEBOARD_DATA_DIR)
    return { dataDir: resolve(env.WHITEBOARD_DATA_DIR), dataDirTrust: 'operator' }
  return { dataDir: resolveDefaultDataDir(env), dataDirTrust: 'owner' }
}
