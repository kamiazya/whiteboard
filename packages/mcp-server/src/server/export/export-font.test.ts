import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as opentype from 'opentype.js'
import { afterEach, describe, expect, it } from 'vitest'
import { EXPORT_FONT_FAMILY, readFontFamilyName, resolveExportFontFaces } from './export-font.js'

describe('resolveExportFontFaces', () => {
  let packageRoot: string | undefined

  afterEach(() => {
    if (packageRoot) rmSync(packageRoot, { recursive: true, force: true })
    packageRoot = undefined
  })

  it('resolves the src-layout asset when only assets/fonts/Roboto exists', async () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'export-font-'))
    const dir = join(packageRoot, 'assets', 'fonts', 'Roboto')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Roboto-Regular.ttf'), 'not-a-real-font')

    const resolved = await resolveExportFontFaces(packageRoot)
    expect(resolved.regular).toBe(join(dir, 'Roboto-Regular.ttf'))
    // Sibling faces missing from a partial layout resolve to null, not throw.
    expect(resolved.bold).toBeNull()
  })

  it('resolves the dist-layout asset when only dist/assets/fonts/Roboto exists', async () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'export-font-'))
    const dir = join(packageRoot, 'dist', 'assets', 'fonts', 'Roboto')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Roboto-Regular.ttf'), 'not-a-real-font')

    const resolved = await resolveExportFontFaces(packageRoot)
    expect(resolved.regular).toBe(join(dir, 'Roboto-Regular.ttf'))
    // Sibling faces missing from a partial layout resolve to null, not throw.
    expect(resolved.bold).toBeNull()
  })

  it('prefers the dist-layout asset when both layouts are present', async () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'export-font-'))
    const distDir = join(packageRoot, 'dist', 'assets', 'fonts', 'Roboto')
    const srcDir = join(packageRoot, 'assets', 'fonts', 'Roboto')
    mkdirSync(distDir, { recursive: true })
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(distDir, 'Roboto-Regular.ttf'), 'dist-copy')
    writeFileSync(join(srcDir, 'Roboto-Regular.ttf'), 'stale-src-copy')

    const resolved = await resolveExportFontFaces(packageRoot)
    expect(resolved.regular).toBe(join(distDir, 'Roboto-Regular.ttf'))
  })

  it('returns all-null when neither layout has the assets', async () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'export-font-'))

    const resolved = await resolveExportFontFaces(packageRoot)
    expect(resolved).toEqual({ regular: null, bold: null, italic: null, boldItalic: null })
  })

  it('resolves every vendored face from this package root', async () => {
    const resolved = await resolveExportFontFaces()
    expect(resolved.regular).not.toBeNull()
    expect(resolved.bold).not.toBeNull()
    expect(resolved.italic).not.toBeNull()
    expect(resolved.boldItalic).not.toBeNull()
  })

  it('every vendored face is a valid TTF/OTF opentype.js can parse (not a woff2)', async () => {
    const resolved = await resolveExportFontFaces()
    for (const path of Object.values(resolved)) {
      if (!path) throw new Error('expected every vendored export face to resolve')
      const font = opentype.parse(readFileSync(path))
      expect(font.unitsPerEm).toBeGreaterThan(0)
    }
  })

  it('EXPORT_FONT_FAMILY matches the family name reported by every vendored face', async () => {
    const resolved = await resolveExportFontFaces()
    for (const path of [resolved.regular, resolved.bold]) {
      if (!path) throw new Error('expected the vendored export font to resolve')
      const font = opentype.parse(readFileSync(path))
      expect(readFontFamilyName(font)).toBe(EXPORT_FONT_FAMILY)
    }
    // Italic faces report the same FAMILY, distinguished by subfamily —
    // resvg groups them under one family for weight/style selection.
    for (const path of [resolved.italic, resolved.boldItalic]) {
      if (!path) throw new Error('expected the vendored export font to resolve')
      const font = opentype.parse(readFileSync(path))
      expect(readFontFamilyName(font)).toBe(EXPORT_FONT_FAMILY)
    }
  })
})

describe('readFontFamilyName reads every shape a face may record its family in', () => {
  type Names = Parameters<typeof readFontFamilyName>[0]
  const face = (names: unknown) => ({ names }) as unknown as Names

  it('prefers the English entry of the windows record', () => {
    expect(
      readFontFamilyName(face({ windows: { fontFamily: { ja: 'ヨモギ', en: 'Yomogi' } } })),
    ).toBe('Yomogi')
  })

  it('takes the first entry when the record has no English one', () => {
    expect(readFontFamilyName(face({ windows: { fontFamily: { ja: 'ヨモギ' } } }))).toBe('ヨモギ')
  })

  it('falls through to the macintosh record, then to the flat shape the typings advertise', () => {
    expect(readFontFamilyName(face({ macintosh: { fontFamily: { en: 'Mac Only' } } }))).toBe(
      'Mac Only',
    )
    expect(readFontFamilyName(face({ fontFamily: 'Flat String' }))).toBe('Flat String')
    expect(readFontFamilyName(face({ fontFamily: { en: 'Flat Locale' } }))).toBe('Flat Locale')
  })

  it('skips a record whose name is empty and answers undefined when none carries one', () => {
    expect(
      readFontFamilyName(
        face({ windows: { fontFamily: { en: '' } }, macintosh: { fontFamily: { en: 'Second' } } }),
      ),
    ).toBe('Second')
    expect(readFontFamilyName(face({ windows: { fontFamily: { en: '' } } }))).toBeUndefined()
    expect(readFontFamilyName(face({}))).toBeUndefined()
  })
})
