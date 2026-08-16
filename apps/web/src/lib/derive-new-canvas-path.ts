// Naming-follows-creation sibling of deriveCopyPath: the icon-only "+"
// control creates a canvas with no typed name, so it needs a path the
// server's validateDocumentPath (letters/digits/hyphen only) always accepts.
export function deriveNewCanvasPath(existingPaths: readonly string[]): string {
  const existing = new Set(existingPaths)
  if (!existing.has('untitled')) return 'untitled'
  let n = 2
  while (existing.has(`untitled-${n}`)) n++
  return `untitled-${n}`
}
