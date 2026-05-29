import { stat } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'

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
  }
  if (overwrite) return
  if (await fileExistsOrThrow(outputPath)) {
    throw new OutputPathError(
      'output_exists',
      `outputPath already exists. Pass overwrite=true to replace it: ${outputPath}`,
    )
  }
}
