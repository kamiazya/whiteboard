/**
 * The origin the vendored font is fetched from is written twice because the
 * two sides may not share a constant: daemon-client's `FONT_SOURCE_ORIGIN`
 * is what the server fetches from and what the CSP allows, and the sandboxed
 * widget in canvas-viewer (which may not import daemon-client) re-checks a URL
 * against its own copy before it requests anything. A copy that drifted would
 * refuse every download the server had just permitted, or accept one the
 * server would refuse — and the widget's own test pins its own literal, so
 * nothing but this comparison reads both.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const ORIGIN_CONSTANTS = [
  { name: 'FONT_SOURCE_ORIGIN', file: 'packages/daemon-client/src/api-contracts/fonts.ts' },
  { name: 'WIDGET_FONT_SOURCE_ORIGIN', file: 'packages/canvas-viewer/src/widget/theme-font.ts' },
] as const

/** The string a file declares as `name` (exported or not), or undefined when it declares none. */
function declaredLiteral(source: string, name: string): string | undefined {
  return new RegExp(`^(?:export )?const ${name}\\s*=\\s*(['"])([^'"]*)\\1`, 'm').exec(source)?.[2]
}

describe('the font source origin is named identically by the server and the widget', () => {
  const declared = ORIGIN_CONSTANTS.map(({ name, file }) => ({
    name,
    file,
    literal: declaredLiteral(readFileSync(join(REPO_ROOT, file), 'utf8'), name),
  }))

  it.each(declared)('$name is a string literal declared in $file', ({ literal }) => {
    // A constant rewritten as an import or a template is no longer a literal
    // this scan can read, and an agreement it cannot read is not one it checked.
    expect(literal).toMatch(/^https:\/\/[^/]+$/)
  })

  it('names one origin on both sides', () => {
    expect(new Set(declared.map(({ literal }) => literal)).size).toBe(1)
  })

  it('reads a declaration whether or not it is exported', () => {
    expect(declaredLiteral("export const X = 'https://a.example'", 'X')).toBe('https://a.example')
    expect(declaredLiteral('const X = "https://a.example"', 'X')).toBe('https://a.example')
    expect(declaredLiteral("// const X = 'https://a.example'", 'X')).toBeUndefined()
  })
})
