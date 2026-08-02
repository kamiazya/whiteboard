// The canonical export font: a single vendored static TTF used by
// createOpentypeMeasureText (measure-text.ts) and, later, the headless SVG
// export renderer. canvas-viewer vendors a byte-identical copy of this same
// file and loads it as a real webfont (its own font-loading.ts, wired in at
// apps/web's bootstrap) under the matching VIEWER_FONT_FAMILY, so Node and
// browser export output agree on metrics — the family name and asset path
// are each declared exactly once here so no second copy of the string can
// drift from this one.
//
// Roboto-Regular.ttf is vendored under assets/fonts/Roboto (Apache-2.0,
// see assets/fonts/Roboto/LICENSE.txt) as a static (non-variable) face:
// opentype.js's variable-font axis support is weaker and a variable font's
// default-instance metrics are less predictable than a dedicated static
// Regular face.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Font as OpentypeFont } from 'opentype.js'

import { findPackageRoot } from '../../shared/package-root.js'

export const EXPORT_FONT_FAMILY = 'Roboto'

const EXPORT_FONT_RELATIVE_SEGMENTS = ['fonts', 'Roboto', 'Roboto-Regular.ttf'] as const

/**
 * Resolves the vendored export font's absolute path, or `null` if it is not
 * present under either layout this package ships as.
 *
 * The dist candidate is checked first: a stale src-mode copy must never
 * shadow the file a real `pnpm build` actually produces, since dist is the
 * only layout the published tarball or a `pnpm build`'d dev daemon serves
 * from.
 */
export async function resolveExportFontFile(
  packageRoot: string = findPackageRoot(import.meta.url),
): Promise<string | null> {
  const candidates = [
    resolve(packageRoot, 'dist', 'assets', ...EXPORT_FONT_RELATIVE_SEGMENTS),
    resolve(packageRoot, 'assets', ...EXPORT_FONT_RELATIVE_SEGMENTS),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

// @types/opentype.js's `FontNames` interface still models the pre-locale-
// grouping shape (flat `fontFamily`/`fullName`/... keys). The installed
// opentype.js runtime nests every name record under a locale-source key
// (`windows`/`mac`) instead, so the type and the runtime disagree here —
// read through an `unknown` cast rather than widening the public `Font`
// import type.
interface OpentypeLocalizedNames {
  readonly windows?: { readonly fontFamily?: { readonly en?: string } }
}

/** The font's English family name as recorded in its `name` table, if present. */
export function readFontFamilyName(font: OpentypeFont): string | undefined {
  return (font.names as unknown as OpentypeLocalizedNames).windows?.fontFamily?.en
}
