import { accessSync, constants, statSync } from 'node:fs'
import { homedir, tmpdir as osTmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

function defaultCheckWritable(path: string): boolean {
  try {
    const st = statSync(path)
    if (!st.isDirectory()) return false
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export interface DataDirOptions {
  checkWritable?: (path: string) => boolean
  homeDir?: string
  tmpDir?: string
}

export function resolveDefaultDataDir(
  env: Record<string, string | undefined>,
  options?: DataDirOptions,
): string {
  const envOverride = env.WHITEBOARD_DATA_DIR
  if (envOverride !== undefined) {
    return isAbsolute(envOverride) ? envOverride : resolve(envOverride)
  }

  const homeDir = options?.homeDir ?? homedir()
  const tmpDir = options?.tmpDir ?? osTmpdir()
  const checkWritable = options?.checkWritable ?? defaultCheckWritable

  const homeCandidate = join(homeDir, '.whiteboard')
  if (checkWritable(homeCandidate)) {
    return homeCandidate
  }
  return join(tmpDir, '.whiteboard')
}
