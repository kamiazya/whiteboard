import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalizeWithMissingTail,
  isWithinAllowedRoots,
  lstatOrNull,
} from '../path-containment.js'
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

// Stable order. The manifest must be written last so a reader that
// sees `manifest.json` can trust every section it lists exists. The
// `keyof SupportBundle['files']` keeps this in sync with the helper's
// type — adding a new section is a deliberate ack on both sides.
const FILE_WRITE_ORDER: Array<keyof SupportBundle['files']> = [
  'status.json',
  'doctor.json',
  'manifest.json',
]

export async function writeSupportBundle(
  bundle: SupportBundle,
  targetDir: string,
  options: WriteSupportBundleOptions,
): Promise<{ outputDir: string; files: string[] }> {
  // Canonicalise BEFORE the containment check, so a symlinked ancestor cannot
  // pass a string-prefix guard; the entry written through must not be a symlink.
  const canonicalTarget = await canonicalizeWithMissingTail(targetDir, {
    symlinkRefusal: () =>
      new SupportBundleError('Target path traverses a symlink, which is not allowed.'),
  })
  if (!(await isWithinAllowedRoots(canonicalTarget, options.allowedRoots))) {
    // Generic — never echo the resolved target back through stderr.
    throw new SupportBundleError('Target directory is not inside an allowed root.')
  }

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
    // Surface in manifest order (status / doctor / manifest)
    // for callers that print the list — predictable for tests and
    // smoke output diffs.
    files: [...FILE_WRITE_ORDER],
  }
}
