// Characters that are invalid in a filename on common filesystems (Windows
// in particular) — a path's `/` among them — become `-`, so the download never
// silently fails. So do the C0 and C1 controls and DEL, and the bidi
// embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069): the save
// dialog renders the name it is handed, and an override reorders everything
// after it, so the name shown would not be the name of the file saved.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this pattern's purpose
const UNSAFE_IN_FILENAME = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

export function sanitizeExportFilenameBase(base: string): string {
  return base.replace(UNSAFE_IN_FILENAME, '-')
}
