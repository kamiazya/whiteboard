/**
 * Three packages name the one vendored family with a string literal of their
 * own, because none of them may import another's constant: canvas-render
 * declares it in every label run, mcp-server's measurer and resvg resolve it,
 * and canvas-viewer registers and measures it. A drift reads as a perfectly
 * working export — the SVG names one family, the measurer measured another —
 * so nothing but this comparison notices it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const FAMILY_CONSTANTS = [
  { name: 'SPATIAL_THEME_FONT_FAMILY', file: 'packages/canvas-render/src/theme/font-family.ts' },
  { name: 'VIEWER_FONT_FAMILY', file: 'packages/canvas-viewer/src/font.ts' },
  { name: 'EXPORT_FONT_FAMILY', file: 'packages/mcp-server/src/server/export/export-font.ts' },
] as const

/** The string a file exports as `name`, or undefined when it declares none. */
function declaredLiteral(source: string, name: string): string | undefined {
  return new RegExp(`export const ${name}\\s*=\\s*(['"])([^'"]*)\\1`).exec(source)?.[2]
}

describe('the vendored font family is named identically by every package', () => {
  const declared = FAMILY_CONSTANTS.map(({ name, file }) => ({
    name,
    file,
    literal: declaredLiteral(readFileSync(join(REPO_ROOT, file), 'utf8'), name),
  }))

  it.each(declared)('$name is a string literal declared in $file', ({ literal }) => {
    // A constant rewritten as a re-export or a template is no longer a literal
    // this scan can read, and an agreement it cannot read is not one it checked.
    expect(literal).toBeTypeOf('string')
    expect(literal).not.toBe('')
  })

  it('names one family across all three', () => {
    expect(new Set(declared.map(({ literal }) => literal)).size).toBe(1)
  })
})
