import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { isMissingFileError } from './errno.js'

/**
 * Where a path really is, though part of it does not exist yet: the real path
 * of its deepest existing ancestor with the missing remainder appended.
 *
 * `resolve()` does not follow symlinks, so an ancestor symlink
 * (`<allowed>/link -> /outside`) passes a plain prefix check while pointing
 * outside the allowed tree; `realpath` on the deepest existing ancestor is
 * what closes that. A segment that does not exist cannot be a symlink yet, so
 * the tail needs no resolving.
 *
 * `symlinkRefusal` is the one policy a caller chooses. Given, the deepest
 * existing component of the path itself is refused when it is a symlink, with
 * that error, because the caller will write through that entry; a symlink
 * above it is still followed and judged by where it lands. Omitted, any
 * symlink is followed.
 */
export async function canonicalizeWithMissingTail(
  path: string,
  options: { readonly symlinkRefusal?: () => Error } = {},
): Promise<string> {
  const absolute = resolve(path)
  let existing = absolute
  const missingTail: string[] = []
  while (existing !== dirname(existing)) {
    const stat = await lstatOrNull(existing)
    if (stat !== null) {
      if (stat.isSymbolicLink() && options.symlinkRefusal !== undefined) {
        throw options.symlinkRefusal()
      }
      break
    }
    missingTail.unshift(basename(existing))
    existing = dirname(existing)
  }
  const realExisting = await realpath(existing)
  return missingTail.length === 0 ? realExisting : join(realExisting, ...missingTail)
}

/**
 * Whether an already canonical `target` is one of `roots` or below one.
 *
 * Each root is canonicalised the same way as the target, including a root that
 * does not exist yet: it contains what is written below it, and its existing
 * ancestor was resolved, so it cannot reach outside through a link. Compared
 * on whole path segments, so `/a/bc` is not inside `/a/b`.
 */
export async function isWithinAllowedRoots(
  target: string,
  roots: readonly string[],
): Promise<boolean> {
  for (const root of roots) {
    const canonicalRoot = await canonicalizeWithMissingTail(root)
    const prefix = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep
    if (target === canonicalRoot || target.startsWith(prefix)) return true
  }
  return false
}

/**
 * Whether a string is ONE path segment that names a child: not empty, not `.`
 * or `..`, and holding no separator of either platform or NUL.
 *
 * For a name an artifact supplies (a tenant id in a backup manifest) that is
 * then joined under a directory the reader owns. `join` collapses `..`, so
 * without this a name is a way out of that directory rather than a name in it.
 */
export function isSafePathSegment(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !/[\\/\0]/.test(name)
}

/**
 * Whether a string is a relative path of `/`-separated safe segments. Refuses
 * an absolute path, an empty or `.` segment (`a//b`, `a/./b`), `..` anywhere,
 * and a backslash, so the string means the same on every platform it is
 * joined on and cannot resolve outside the directory it is joined under.
 */
export function isSafeRelativePosixPath(path: string): boolean {
  return path.split('/').every(isSafePathSegment)
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (err) {
    if (isMissingFileError(err)) return null
    throw err
  }
}
