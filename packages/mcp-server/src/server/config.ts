import { constants as fsConstants } from 'node:fs'
import { accessSync, chmodSync, mkdirSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// From src/server/config.ts, going up two directories reaches the package root.
export const WHITEBOARD_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Force owner-only permissions for the data dir, tokens, and stored
// canvases. On shared VMs or dev containers, a default umask like 0755 can
// leave daemon tokens readable by other users. Windows ignores POSIX modes
// here.
const POSIX_DATA_DIR_MODE = 0o700

function canWriteDir(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true, mode: POSIX_DATA_DIR_MODE })
    accessSync(path, fsConstants.R_OK | fsConstants.W_OK)
    // Recursive mkdir plus umask can still leave the wrong mode behind.
    // On Windows, chmod is effectively a no-op beyond the read-only bit.
    if (platform() !== 'win32') {
      try {
        chmodSync(path, POSIX_DATA_DIR_MODE)
      } catch {
        /* Tightening permissions is best-effort; startup should continue on failure. */
      }
    }
    return true
  } catch {
    return false
  }
}

export function resolveDataDir(
  env: NodeJS.ProcessEnv = process.env,
  options: {
    homeDir?: string
    tmpDir?: string
    isWritableDir?: (path: string) => boolean
  } = {},
): string {
  if (env.WHITEBOARD_DATA_DIR) {
    return resolve(env.WHITEBOARD_DATA_DIR)
  }

  const homeCandidate = resolve(options.homeDir ?? homedir(), '.whiteboard')
  const isWritableDir = options.isWritableDir ?? canWriteDir
  if (isWritableDir(homeCandidate)) {
    return homeCandidate
  }

  // In the Codex sandbox, the home directory may not be writable.
  // Fall back to tmp only when there is no explicit env override.
  return resolve(options.tmpDir ?? tmpdir(), '.whiteboard')
}

export const DATA_DIR = resolveDataDir()
export const DIST_APP_DIR = resolve(WHITEBOARD_ROOT, 'dist/app')
