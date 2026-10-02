import { accessSync, constants as fsConstants } from 'node:fs'

/** Whether this process can write to `dir`, as the runtime status reports it. */
export function isDataDirWritable(dir: string): boolean {
  try {
    accessSync(dir, fsConstants.W_OK)
    return true
  } catch {
    return false
  }
}
