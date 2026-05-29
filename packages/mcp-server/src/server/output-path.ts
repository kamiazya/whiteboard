import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'

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

// realpath() of the nearest existing ancestor of `p`. The output file itself usually
// does not exist yet, so we resolve the closest ancestor that does and let the caller
// re-check containment against it. ENOENT walks up one level; any other error propagates.
async function realpathNearestExisting(p: string): Promise<string> {
  let current = p
  while (true) {
    try {
      return await realpath(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) return current
      current = parent
    }
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
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return false
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
    const resolvedPath = resolve(outputPath)
    if (resolvedPath !== resolvedDir && !resolvedPath.startsWith(resolvedDir + sep)) {
      throw new OutputPathError(
        'invalid_output_path',
        `outputPath must be inside the allowed directory (${resolvedDir})`,
      )
    }
    // The lexical check above only collapses `..`; it does NOT follow symlinks. A symlink
    // inside allowedDir that points outside it would pass the string check yet land the write
    // outside the sandbox. Resolve real paths and re-check containment. The target may not
    // exist yet, so compare the real allowedDir against the real nearest-existing ancestor of
    // the target's parent. (Best-effort against the validate→writeFile TOCTOU window; pairs
    // with the resolved-path write, not a full O_NOFOLLOW guarantee.)
    const realAllowedDir = await realpathNearestExisting(resolvedDir)
    const realParent = await realpathNearestExisting(dirname(resolvedPath))
    if (realParent !== realAllowedDir && !realParent.startsWith(realAllowedDir + sep)) {
      throw new OutputPathError(
        'invalid_output_path',
        'outputPath escapes the allowed directory through a symlink',
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
