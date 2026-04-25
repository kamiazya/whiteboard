import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function normalizePath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function isDirectEntryPoint(importMetaUrl: string, argv1 = process.argv[1]): boolean {
  if (!argv1) {
    return false
  }

  return normalizePath(argv1) === normalizePath(fileURLToPath(importMetaUrl))
}
