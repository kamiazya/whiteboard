import { chmod, mkdir } from 'node:fs/promises'

/**
 * A directory any user may add an entry to, so a symlink staged in it is one
 * somebody else could have planted — the case an output-path check refuses.
 * `chmod` after `mkdir` because the mode `mkdir` takes passes through the
 * umask.
 */
export async function makeWritableByOthers(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  await chmod(path, 0o777)
  return path
}
