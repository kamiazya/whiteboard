// Characters that are invalid in a filename on common filesystems (Windows
// in particular) — a path's `/` among them — become `-`, so the download never
// silently fails.
export function sanitizeExportFilenameBase(base: string): string {
  return base.replace(/[\\/:*?"<>|]/g, '-')
}
