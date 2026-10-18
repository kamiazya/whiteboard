import { chmod, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * A backup holds every document and upload, and it lands where an operator
 * keeps backups — often a dir any local user can traverse — so everything a
 * pass writes is its owner's alone. The umask would otherwise leave the
 * snapshot, the copied tree and the mirror world-readable. The operator's
 * own backup root, when it already exists, keeps the mode they gave it: a
 * mounted volume's mode is the platform's to set.
 */
export const BACKUP_DIR_MODE = 0o700
export const BACKUP_FILE_MODE = 0o600

/** Every dir and file under `root`, and `root` itself, closed to everyone else. */
export async function restrictTreeToOwner(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true })
  await Promise.all(
    entries.map((entry) => {
      const path = join(entry.parentPath, entry.name)
      if (entry.isDirectory()) return chmod(path, BACKUP_DIR_MODE)
      if (entry.isFile()) return chmod(path, BACKUP_FILE_MODE)
      return undefined
    }),
  )
  if ((await lstat(root)).isDirectory()) await chmod(root, BACKUP_DIR_MODE)
}
