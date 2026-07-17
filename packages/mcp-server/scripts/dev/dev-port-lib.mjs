import { lstatSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

// Back-compat: the main checkout keeps port 3099, matching every doc,
// hook, and packaged script written before per-worktree ports existed.
const MAIN_CHECKOUT_PORT = 3099
const WORKTREE_PORT_RANGE_START = 3100
const WORKTREE_PORT_RANGE_SIZE = 900

/**
 * Normalizes an absolute repo root path before hashing, so two spellings of
 * the same path (trailing separator, Windows drive-letter case, backslash
 * vs forward slash) always derive the same port. Posix paths stay
 * case-sensitive because macOS/Linux filesystems can be too.
 *
 * @param {string} repoRootAbsPath
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function normalizeRepoRootForHash(repoRootAbsPath, platform = process.platform) {
  const resolved = resolve(repoRootAbsPath)
  const stripped = resolved.endsWith(sep) ? resolved.slice(0, -sep.length) : resolved
  if (platform === 'win32') {
    return stripped.toLowerCase().replaceAll('\\', '/')
  }
  return stripped
}

// FNV-1a: small, dependency-free, stable across Node versions — exactly
// what a deterministic dev-only port derivation needs (not a security hash).
function fnv1aHash(input) {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function parseDevPortOverride(value) {
  if (value === '') {
    throw new Error('WHITEBOARD_DEV_PORT is set but empty; unset it or provide a port 1-65535')
  }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `WHITEBOARD_DEV_PORT must be an integer between 1 and 65535, got ${JSON.stringify(value)}`,
    )
  }
  return parsed
}

/**
 * Derives the dev daemon port for a repo checkout. Single source of truth
 * shared by the with-dev-data-dir spawn wrapper and the ensure-http-dev-daemon
 * probe/spawn hook, so they can never disagree about which port a given
 * worktree's daemon should live on.
 *
 * Precedence: (1) explicit WHITEBOARD_DEV_PORT env override, (2) main
 * checkout -> 3099, (3) hash of the normalized repo root -> [3100, 3999].
 *
 * @param {{ repoRoot: string, isMainCheckout: boolean, env?: Record<string, string | undefined> }} args
 * @returns {number}
 */
export function deriveDevPort({ repoRoot, isMainCheckout, env = {} }) {
  if (env.WHITEBOARD_DEV_PORT !== undefined) {
    return parseDevPortOverride(env.WHITEBOARD_DEV_PORT)
  }
  if (isMainCheckout) {
    return MAIN_CHECKOUT_PORT
  }
  const normalized = normalizeRepoRootForHash(repoRoot)
  const hash = fnv1aHash(normalized)
  return WORKTREE_PORT_RANGE_START + (hash % WORKTREE_PORT_RANGE_SIZE)
}

/**
 * A linked git worktree has a `.git` FILE (`gitdir: <path>`); the main
 * checkout has a `.git` DIRECTORY. Kept as a thin fs-touching helper so
 * deriveDevPort itself stays pure and unit-testable without touching disk.
 *
 * @param {string} repoRoot
 * @returns {boolean}
 */
export function isMainCheckout(repoRoot) {
  const gitPath = join(resolve(repoRoot), '.git')
  let stats
  try {
    stats = lstatSync(gitPath)
  } catch {
    // No .git at all (npm tarball extraction, some sandboxed checkouts) is
    // not a linked worktree — fall back to the main-checkout port (3099)
    // rather than crashing dev startup over a checkout-type check that has
    // no bearing on whether the server itself can run.
    return true
  }
  return stats.isDirectory()
}
