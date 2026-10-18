import { homeDataDirIsUsable, resolveDataDir } from '../shared/data-dir-secure.js'

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
