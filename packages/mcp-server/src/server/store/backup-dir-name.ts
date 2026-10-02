/**
 * A backup directory's name: written by the scheduler, recognised by both
 * retention passes.
 *
 * Retention counts BACKUPS, not directory entries: an operator's own notes
 * file sitting beside them must neither be deleted nor push a real backup out
 * of the window, and the mirror's collector reading one as a backup that
 * references nothing would delete everything it protects. The name is the
 * timestamp with `:` replaced, so it is filesystem-safe on every platform and
 * still sorts chronologically — which is what lets retention order by name
 * rather than by mtime, a field a copy or a restore can rewrite.
 *
 * The writer and the matcher are one module because they are one agreement:
 * a copy of the matcher that drifted from the writer would stop counting real
 * backups, silently, as an unbounded retention window.
 */
const BACKUP_DIR_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/

export function backupDirName(at: Date): string {
  return at.toISOString().replace(/:/g, '-')
}

export function isBackupDirName(name: string): boolean {
  return BACKUP_DIR_NAME.test(name)
}
