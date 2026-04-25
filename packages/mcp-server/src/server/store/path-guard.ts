import { resolve, sep } from 'node:path'
import { ValidationError } from '../validators.js'

export function assertPathWithinDir(
  filePath: string,
  dir: string,
  label: string,
): string {
  const resolvedDir = resolve(dir)
  const resolvedPath = resolve(filePath)
  if (resolvedPath === resolvedDir || resolvedPath.startsWith(resolvedDir + sep)) {
    return filePath
  }
  throw new ValidationError(
    'invalid_path',
    `Invalid ${label}: resolved path "${resolvedPath}" is outside "${resolvedDir}"`,
  )
}
