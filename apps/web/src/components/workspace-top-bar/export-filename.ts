import { leafOfPath } from '@kamiazya/whiteboard-model'

// Characters that are invalid in a filename on common filesystems (Windows
// in particular) — a path's `/` among them — become `-`, so the download never
// silently fails. So do the C0 and C1 controls and DEL, and the bidi
// marks, embeddings, overrides and isolates (U+061C, U+200E-U+200F,
// U+202A-U+202E, U+2066-U+2069): the save
// dialog renders the name it is handed, and an override reorders everything
// after it, so the name shown would not be the name of the file saved.
const UNSAFE_IN_FILENAME =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this pattern's purpose
  /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

export function sanitizeExportFilenameBase(base: string): string {
  return base.replace(UNSAFE_IN_FILENAME, '-')
}

/**
 * The name an exported file is offered under: the document's display name in
 * whatever script it is written — `概要.md`, never an ASCII approximation —
 * with only what a filesystem refuses taken out (`sanitizeExportFilenameBase`),
 * the ends trimmed, and the trailing dots Windows drops removed. A name that
 * leaves nothing a person could recognise (absent, blank, only separators)
 * gives way to the address's last segment, which always reads.
 */
export function exportFilenameBaseFor(name: string | null | undefined, path: string): string {
  let fromName = sanitizeExportFilenameBase(name ?? '').trim()
  // A loop rather than `/[.\s]+$/`, which backtracks polynomially on a long
  // run that does not reach the end.
  while (fromName.endsWith('.') || fromName.endsWith(' '))
    fromName = fromName.slice(0, -1).trimEnd()
  if (/[^\s.-]/u.test(fromName)) return fromName
  return leafOfPath(path)
}
