import { lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { type SupportBundle, SupportBundleError } from './support-bundle.js'

// Filesystem writer for the v0 support bundle. Lives apart from
// `support-bundle.ts` (the pure helper) so the helper can stay
// side-effect-free and the writer can be tested in isolation.
//
// Contract:
//   - target directory must canonicalize inside one of the
//     caller-provided `allowedRoots` (path traversal guard);
//   - target must be missing OR an existing empty directory; existing
//     non-empty directories and existing files fail closed without
//     touching anything;
//   - target must NOT be a symlink (and the parent traversal must not
//     follow one) — same posture as the backup/restore helper;
//   - writes are validated-then-written: the helper does the
//     existence / emptiness / symlink checks first, then writes the
//     four bundle files in a stable order. A write failure mid-way
//     surfaces as a thrown `SupportBundleError`; the helper does NOT
//     try to roll back partial writes (deleting user files is more
//     dangerous than a partial directory).

export interface WriteSupportBundleOptions {
  // Allowed roots for the target directory. Tests pass their mkdtemp
  // root; runtime callers (a future support-bundle CLI) pass the
  // user-supplied parent dir. Symlinks are not followed.
  allowedRoots: string[]
}

function isInside(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent + sep)
}

async function lstatOrNullSync(path: string) {
  try {
    return await lstat(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

// Resolve `target` against the filesystem in a symlink-aware way:
//   - walk every existing ancestor with `lstat` and reject any
//     symlink encountered (parent-traversal guard);
//   - take the realpath of the deepest existing ancestor and append
//     the missing tail segments;
//   - return the canonicalised absolute path.
//
// Rejects with `SupportBundleError` if any ancestor is a symlink.
async function canonicaliseTarget(target: string): Promise<string> {
  const absolute = resolve(target)
  // Walk from the absolute root downward, lstat'ing each segment.
  // The first existing ancestor is the deepest one we can `realpath`
  // safely; missing leaf segments don't need realpath because they
  // can't be a symlink yet.
  const parts = absolute.split(sep).filter((p) => p.length > 0)
  // POSIX absolute paths start at '/'. On Windows the first segment
  // is the drive letter; preserve it as-is via dirname() walking.
  let existing = absolute
  const missingTail: string[] = []
  while (existing !== dirname(existing)) {
    const stat = await lstatOrNullSync(existing)
    if (stat !== null) {
      if (stat.isSymbolicLink()) {
        throw new SupportBundleError(
          'Target path traverses a symlink, which is not allowed.',
        )
      }
      break
    }
    missingTail.unshift(parts[parts.length - 1 - missingTail.length] ?? '')
    existing = dirname(existing)
  }
  // existing is now either the deepest existing ancestor or the
  // filesystem root. realpath canonicalises any symlinks BELOW
  // the lstat-checked chain (defence in depth — lstat already
  // rejected each level, but realpath catches anything mounted /
  // bound between lstat and the next syscall).
  const realExisting = await realpath(existing)
  return missingTail.length === 0 ? realExisting : join(realExisting, ...missingTail)
}

async function assertWithinAllowed(
  canonicalTarget: string,
  options: WriteSupportBundleOptions,
): Promise<void> {
  for (const root of options.allowedRoots) {
    let canonicalRoot: string
    try {
      canonicalRoot = await realpath(resolve(root))
    } catch {
      // A nonexistent allowed-root entry can't contain anything;
      // skip it rather than throwing — a follow-up entry may match.
      continue
    }
    if (isInside(canonicalTarget, canonicalRoot)) return
    // Belt-and-suspenders: also require the relative path to not
    // start with `..` — the prefix check above already covers it,
    // but `relative()` makes the intent explicit for the reader.
    const rel = relative(canonicalRoot, canonicalTarget)
    if (rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`))) {
      // Already accepted by the prefix check; this branch is
      // unreachable in practice but documents the invariant.
      return
    }
  }
  // Generic — never echo the resolved target. A future CLI surface
  // could otherwise leak the user's local path back through stderr.
  throw new SupportBundleError('Target directory is not inside an allowed root.')
}

async function lstatOrNull(path: string) {
  return lstatOrNullSync(path)
}

// Stable order. The manifest must be written last so a reader that
// sees `manifest.json` can trust every section it lists exists. The
// `keyof SupportBundle['files']` keeps this in sync with the helper's
// type — adding a new section is a deliberate ack on both sides.
const FILE_WRITE_ORDER: Array<keyof SupportBundle['files']> = [
  'status.json',
  'doctor.json',
  'logs.jsonl',
  'manifest.json',
]

export async function writeSupportBundle(
  bundle: SupportBundle,
  targetDir: string,
  options: WriteSupportBundleOptions,
): Promise<{ outputDir: string; files: string[] }> {
  // Canonicalise BEFORE the containment check so a symlinked
  // ancestor (e.g. `<root>/link → /outside`) cannot pass a naive
  // string-prefix guard. The walk also rejects ancestor symlinks
  // outright, matching the parent-traversal contract documented
  // above.
  // Canonicalise BEFORE the containment check so a symlinked
  // ancestor (e.g. `<root>/link → /outside`) cannot pass a naive
  // string-prefix guard. The walk also rejects ancestor symlinks
  // outright, matching the parent-traversal contract documented
  // above.
  const canonicalTarget = await canonicaliseTarget(targetDir)
  await assertWithinAllowed(canonicalTarget, options)

  const stat = await lstatOrNull(targetDir)
  if (stat !== null) {
    if (stat.isSymbolicLink()) {
      throw new SupportBundleError('Target directory is a symlink, which is not allowed.')
    }
    if (!stat.isDirectory()) {
      throw new SupportBundleError('Target path exists and is not a directory.')
    }
    const entries = await readdir(targetDir)
    if (entries.length > 0) {
      throw new SupportBundleError('Target directory is not empty.')
    }
  } else {
    // Create the dir; recursive: true is a no-op if it already exists
    // (it doesn't here, by the lstat branch above) and creates any
    // missing intermediate parents under the allowed root.
    await mkdir(targetDir, { recursive: true })
  }

  for (const name of FILE_WRITE_ORDER) {
    const filePath = join(targetDir, name)
    // `wx` flag fails closed if the file already exists — belt-and-
    // suspenders against a race where the empty-target check passed
    // but something else wrote a file in between.
    await writeFile(filePath, bundle.files[name], { encoding: 'utf-8', flag: 'wx' })
  }

  return {
    outputDir: targetDir,
    // Surface in manifest order (status / doctor / logs / manifest)
    // for callers that print the list — predictable for tests and
    // smoke output diffs.
    files: [...FILE_WRITE_ORDER],
  }
}
