import { accessSync, chmodSync, constants as fsConstants, mkdirSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { isErrnoCode, isMissingFileError } from './errno.js'
import { findPackageRoot } from './package-root.js'

// The package root (holds package.json + dist/). Resolved by walking up to
// package.json — not a fixed offset — so it stays correct even when the bundler
// hoists this module's body into a chunk at a different depth. See package-root.ts.
export const WHITEBOARD_ROOT = findPackageRoot(import.meta.url)

// Force owner-only permissions for the data dir, tokens, and stored
// documents. On shared VMs or dev containers, a default umask like 0755 can
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

/**
 * Refuses a data dir another user owns. Whoever owns it controls `daemon.json`
 * and so the socket and token a client trusts — a real risk when the dir is
 * `$TMPDIR/.whiteboard`, which any user can create first. Mode bits say
 * nothing here: an owner-only dir is exactly what that user would make.
 * A dir that does not exist yet is fine; where there is no uid (Windows)
 * there is nothing to compare.
 */
export function assertDataDirOwnedByUser(
  dir: string,
  uid = process.getuid?.(),
  { mustExist = false }: { mustExist?: boolean } = {},
): void {
  if (uid === undefined) return
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(dir)
  } catch (err) {
    if (!isMissingFileError(err)) throw err
    if (!mustExist) return
    throw new Error(`the data directory ${dir} no longer exists while a file in it is open.`)
  }
  if (stat.uid !== uid) {
    throw new Error(
      `the data directory ${dir} is owned by uid ${stat.uid}, not this user (uid ${uid}). ` +
        'Another user may have created it; set WHITEBOARD_DATA_DIR to a directory you own.',
    )
  }
  // World-writable lets anyone replace daemon.json. Group-writable is left
  // alone: under user-private groups (umask 002) that group is this user.
  if ((Number(stat.mode) & 0o002) !== 0) {
    throw new Error(
      `the data directory ${dir} is writable by other users (mode ${(Number(stat.mode) & 0o777).toString(8)}). ` +
        `Run \`chmod 700 ${dir}\`.`,
    )
  }
}

/**
 * Whether an opened record file is one this user can trust, judged from its
 * stat alone so the verdict can be exercised without a file another user
 * owns — which a test run as an ordinary user cannot create.
 */
export function refuseForeignRecordFile(
  stat: { uid: number; nlink: number },
  path: string,
  uid: number | undefined,
): { kind: 'not-owned'; message: string } | undefined {
  if (uid === undefined) return undefined
  // The record is only ever written by rename, so a second name means a
  // file of this user's was linked in from somewhere else.
  if (stat.nlink > 1) {
    return { kind: 'not-owned', message: `${path} has another hard link; refusing to read it.` }
  }
  if (stat.uid !== uid) {
    return {
      kind: 'not-owned',
      message: `${path} is owned by uid ${stat.uid}, not this user (uid ${uid}).`,
    }
  }
  return undefined
}

/**
 * A file's text, judged on the OPENED handle: `not-owned` when another user
 * owns it, `missing` when there is none. Checking the handle rather than the
 * path first is what closes the window where a directory missing at
 * `assertDataDirOwnedByUser` is created, record and all, before the read.
 * A symlink is never followed (a planted one could point at a file this user
 * does own), and the directory is judged again once the file is open in it.
 */
export async function readFileOwnedByUser(
  path: string,
  uid = process.getuid?.(),
): Promise<
  { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'not-owned'; message: string }
> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // O_NOFOLLOW is undefined on Windows, where the flag is simply absent.
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch (err) {
    if (isMissingFileError(err)) return { kind: 'missing' }
    if (isErrnoCode(err, 'ELOOP'))
      return { kind: 'not-owned', message: `${path} is a symlink; refusing to follow it.` }
    throw err
  }
  try {
    try {
      assertDataDirOwnedByUser(dirname(path), uid, { mustExist: true })
    } catch (err) {
      return { kind: 'not-owned', message: (err as Error).message }
    }
    const refusal = refuseForeignRecordFile(await handle.stat(), path, uid)
    if (refusal !== undefined) return refusal
    return { kind: 'text', text: await handle.readFile('utf-8') }
  } finally {
    await handle.close()
  }
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
