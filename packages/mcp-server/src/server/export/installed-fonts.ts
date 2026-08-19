import { readdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { getDataDir } from '../../shared/data-dir-secure.js'

/**
 * Where a font the user installed lives.
 *
 * A plain directory rather than a manifest, deliberately. Dropping a TTF in is
 * the simplest possible answer to "my exports are tofu", and a mechanism that
 * recognised only its own downloads would refuse it. The download path
 * (ADR-0012) writes here; it does not own the directory.
 */
export function installedFontDir(): string {
  return join(getDataDir(), 'fonts')
}

/**
 * `.ttc` is a collection rather than a single face; both resvg's fontdb and
 * opentype.js read one, so it is admitted alongside the single-face formats.
 *
 * `.woff2` is NOT here. resvg's font database does not decode it, so accepting
 * one would put a file in the directory that silently never renders — worse
 * than refusing it. What the browser loads and what the exporter loads are
 * allowed to differ in FORMAT; they must not differ in which glyphs exist.
 */
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc'])

/**
 * Absolute paths of every installed font, sorted.
 *
 * Sorted because this list reaches resvg's `fontFiles`, and family resolution
 * among faces that declare the same name depends on registration order —
 * directory order is not stable across filesystems, and an export that changes
 * with it would break the byte-identical guarantee for no visible reason.
 *
 * A missing directory is the normal state of a daemon that has installed
 * nothing, so it answers `[]` rather than throwing.
 */
export async function installedFontFiles(): Promise<readonly string[]> {
  const dir = installedFontDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  return entries
    .filter((name) => FONT_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort()
    .map((name) => join(dir, name))
}
