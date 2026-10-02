/**
 * What a thrown value's `code` says, read without trusting that it is an
 * object.
 *
 * Every caller is inside a `catch`, where the thrown value is `unknown`: a
 * cast to `NodeJS.ErrnoException` reads `.code` off it unchecked, so a `null`
 * or a primitive throw becomes a `TypeError` raised from the very handler
 * meant to classify the failure, and the original error is lost.
 * `tools/arch-lint`'s `errno-code-one-place.test.ts` keeps this the only
 * place a code is read.
 */

/** The string `code` an error carries, or `undefined` for anything that has none. */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

export function isErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return errnoCode(error) === code
}

/** The file or directory does not exist: the one failure a read may answer as "nothing here". */
export function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoCode(error, 'ENOENT')
}
