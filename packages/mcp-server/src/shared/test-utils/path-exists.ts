import { stat } from 'node:fs/promises'

/** Whether anything exists at `path`, following symlinks. A stat failure of any kind is "no". */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
