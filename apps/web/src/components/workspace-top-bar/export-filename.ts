// A trailing slash-segment (the canvas leaf) makes the safest download
// filename; characters that are invalid on common filesystems (Windows in
// particular) are replaced so the download never silently fails.
export function sanitizeExportFilenameBase(base: string): string {
  return base.replace(/[\\/:*?"<>|]/g, '-')
}
