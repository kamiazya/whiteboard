import { accessSync, chmodSync, constants as fsConstants, mkdirSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { findPackageRoot } from './package-root.js'

// The package root (holds package.json + dist/). Resolved by walking up to
// package.json — not a fixed offset — so it stays correct even when the bundler
// hoists this module's body into a chunk at a different depth. See package-root.ts.
export const WHITEBOARD_ROOT = findPackageRoot(import.meta.url)

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

export function parentIsWritable(path: string): boolean {
  const parent = resolve(path, '..')
  try {
    accessSync(parent, fsConstants.R_OK | fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}

// Deprecated: a module-load-time snapshot, frozen before a test (or a
// future dev entrypoint) can redirect where data lives. Prefer getDataDir()
// for any new call site — it stays lazily resolved so setDataDirForTests()
// can retarget it before the first real read.
export const DATA_DIR = resolveDataDir(process.env, { isWritableDir: parentIsWritable })

let dataDirOverride: string | undefined
let memoizedDataDir: string | undefined

/**
 * Lazily resolved, test-injectable counterpart to DATA_DIR. Memoizes the
 * first resolveDataDir() call (or the injected override) so repeated reads
 * stay cheap and consistent within a process, while still letting tests
 * redirect persistence to a scratch directory before anything touches disk.
 */
export function getDataDir(): string {
  if (dataDirOverride !== undefined) {
    return dataDirOverride
  }
  if (memoizedDataDir === undefined) {
    memoizedDataDir = resolveDataDir()
  }
  return memoizedDataDir
}

/**
 * Redirect the effective data dir for this process. Production entrypoints
 * (e.g. `daemon run --data-dir=<path>`) call this before anything touches
 * disk so the ENTIRE storage layer — sqlite db, canvas blobs, exports,
 * per-workspace files — follows the requested directory instead of only the
 * daemon registry. The path is resolved to absolute so later cwd changes
 * cannot silently retarget persistence.
 */
export function overrideDataDir(dir: string): void {
  dataDirOverride = resolve(dir)
}

export function setDataDirForTests(dir: string): void {
  dataDirOverride = dir
}

export function resetDataDirForTests(): void {
  dataDirOverride = undefined
  // Also drop the memoized default: a test that changes WHITEBOARD_DATA_DIR
  // (or homedir/tmpdir) after reset must see it reflected on the next
  // getDataDir() call, not a resolution memoized before the reset.
  memoizedDataDir = undefined
}
