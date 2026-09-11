// The canonical export font: vendored static TTFs (four faces) used by
// createOpentypeMeasureText (measure-text.ts) and, later, the headless SVG
// export renderer. canvas-viewer vendors a byte-identical copy of this same
// file and loads it as a real webfont (its own font-loading.ts, wired in at
// apps/web's bootstrap) under the matching VIEWER_FONT_FAMILY, so Node and
// browser export output agree on metrics. Within this package the family
// name and asset path are each declared exactly once, here; canvas-viewer
// necessarily declares its own copy, because the two packages cannot import
// each other (see architecture-map.md), so the cross-package agreement rests
// on the two constants naming the same family rather than on a shared
// declaration.
//
// The Roboto faces are vendored under assets/fonts/Roboto (Apache-2.0,
// see assets/fonts/Roboto/LICENSE.txt) as static (non-variable) files:
// opentype.js's variable-font axis support is weaker and a variable font's
// default-instance metrics are less predictable than dedicated static
// faces. Regular is the anchor; Bold/Italic/BoldItalic exist because the
// layout measures emphasis runs at their real widths and resvg does NOT
// synthesize a missing face — without them, exported bold text would paint
// regular glyphs at bold-measured positions.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Font as OpentypeFont } from 'opentype.js'

import { findPackageRoot } from '../../shared/package-root.js'

export const EXPORT_FONT_FAMILY = 'Roboto'

export type ExportFontFace = 'regular' | 'bold' | 'italic' | 'boldItalic'

const EXPORT_FONT_FILES: Record<ExportFontFace, string> = {
  regular: 'Roboto-Regular.ttf',
  bold: 'Roboto-Bold.ttf',
  italic: 'Roboto-Italic.ttf',
  boldItalic: 'Roboto-BoldItalic.ttf',
}

function resolveFace(packageRoot: string, file: string): string | null {
  // The dist candidate is checked first: a stale src-mode copy must never
  // shadow the file a real `pnpm build` actually produces, since dist is
  // the only layout the published tarball or a `pnpm build`'d dev daemon
  // serves from.
  const candidates = [
    resolve(packageRoot, 'dist', 'assets', 'fonts', 'Roboto', file),
    resolve(packageRoot, 'assets', 'fonts', 'Roboto', file),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Resolves the vendored export faces' absolute paths; a face missing under
 * both layouts resolves to `null` (callers degrade per face — a missing
 * Bold falls back to Regular metrics/glyphs, it never blocks the export).
 */
export async function resolveExportFontFaces(
  packageRoot: string = findPackageRoot(import.meta.url),
): Promise<Record<ExportFontFace, string | null>> {
  return {
    regular: resolveFace(packageRoot, EXPORT_FONT_FILES.regular),
    bold: resolveFace(packageRoot, EXPORT_FONT_FILES.bold),
    italic: resolveFace(packageRoot, EXPORT_FONT_FILES.italic),
    boldItalic: resolveFace(packageRoot, EXPORT_FONT_FILES.boldItalic),
  }
}

/**
 * The font's English family name as recorded in its `name` table, if present.
 *
 * The name lives under a PLATFORM record, and which one a face carries is not
 * fixed — the vendored Roboto has `windows` and nothing else, while
 * `@types/opentype.js` still models the pre-locale-grouping shape and
 * advertises a flat `names.fontFamily` that is undefined there. All three
 * shapes are read, and the English entry preferred, because that is what a
 * `font-family` declaration is written against. Reading only the typed path
 * returned no family for any face at all, which is a silence rather than an
 * error: every family question then answers "no".
 *
 * Read through an `unknown` cast rather than by widening the public `Font`
 * import type, since the disagreement is with the vendor typings.
 */
export function readFontFamilyName(font: OpentypeFont): string | undefined {
  const names = font.names as unknown as Record<string, Record<string, unknown> | undefined>
  for (const record of [names.windows, names.macintosh, names]) {
    const family = record?.fontFamily as Record<string, string> | string | undefined
    const name =
      typeof family === 'string' ? family : (family?.en ?? Object.values(family ?? {})[0])
    if (typeof name === 'string' && name !== '') return name
  }
  return undefined
}
