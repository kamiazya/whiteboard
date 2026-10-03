import { stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isMissingFileError } from '../shared/errno.js'
import { canonicalizeWithMissingTail, isWithinAllowedRoots } from '../shared/path-containment.js'

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejection-class regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f-\x9f]/

export type OutputPathErrorCode = 'invalid_output_path' | 'output_exists'

export class OutputPathError extends Error {
  readonly name = 'OutputPathError'
  constructor(
    readonly code: OutputPathErrorCode,
    message: string,
  ) {
    super(message)
  }
}

// Returns true only when stat reports ENOENT. Any other failure (EACCES, etc.)
// surfaces as a thrown error so callers do not silently treat permission
// problems as "file does not exist" and step over them with writeFile.
async function fileExistsOrThrow(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isMissingFileError(error)) {
      return false
    }
    throw error
  }
}

// A dangling symlink in the parent chain has no real path, and the write would create its
// target; that is the same refusal as a leaf symlink, not an unexpected I/O failure.
async function canonicalizeOutputTarget(resolvedPath: string): Promise<string> {
  try {
    const canonicalParent = await canonicalizeWithMissingTail(dirname(resolvedPath))
    return await canonicalizeWithMissingTail(join(canonicalParent, basename(resolvedPath)), {
      symlinkRefusal: () =>
        new OutputPathError(
          'invalid_output_path',
          'outputPath is a symbolic link; the write would go through it',
        ),
    })
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new OutputPathError('invalid_output_path', 'outputPath goes through a dangling symlink')
    }
    throw error
  }
}

export async function validateOutputPath(
  outputPath: string,
  overwrite: boolean,
  allowedDir?: string,
): Promise<void> {
  if (!isAbsolute(outputPath)) {
    throw new OutputPathError(
      'invalid_output_path',
      `outputPath must be an absolute path (received: ${outputPath})`,
    )
  }
  if (allowedDir !== undefined) {
    if (CONTROL_CHAR_PATTERN.test(outputPath)) {
      throw new OutputPathError('invalid_output_path', 'outputPath contains invalid characters')
    }
    const resolvedDir = resolve(allowedDir)
    // `resolve` only collapses `..`; a symlink inside allowedDir would pass a string check
    // yet land the write outside it. So the parent is canonicalised (symlinks followed, the
    // missing tail kept) and judged by where it really is. The leaf is then checked on its
    // own: writeFile follows it, and a dangling one reads as "missing" to stat() while the
    // write creates its target wherever it points. (Best-effort against the
    // validate-to-writeFile TOCTOU window, not an O_NOFOLLOW guarantee.)
    const resolvedPath = resolve(outputPath)
    const canonicalTarget = await canonicalizeOutputTarget(resolvedPath)
    if (!(await isWithinAllowedRoots(canonicalTarget, [resolvedDir]))) {
      throw new OutputPathError(
        'invalid_output_path',
        `outputPath must be inside the allowed directory (${resolvedDir})`,
      )
    }
  }
  if (overwrite) return
  if (await fileExistsOrThrow(outputPath)) {
    throw new OutputPathError(
      'output_exists',
      `outputPath already exists. Pass overwrite=true to replace it: ${outputPath}`,
    )
  }
}
