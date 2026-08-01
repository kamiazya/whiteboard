import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as opentype from 'opentype.js'
import { afterEach, describe, expect, it } from 'vitest'
import { EXPORT_FONT_FAMILY, readFontFamilyName, resolveExportFontFile } from './export-font.js'

describe('resolveExportFontFile', () => {
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

    const resolved = await resolveExportFontFile(packageRoot)
    expect(resolved).toBe(join(dir, 'Roboto-Regular.ttf'))
  })

  it('resolves the dist-layout asset when only dist/assets/fonts/Roboto exists', async () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'export-font-'))
    const dir = join(packageRoot, 'dist', 'assets', 'fonts', 'Roboto')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Roboto-Regular.ttf'), 'not-a-real-font')

    const resolved = await resolveExportFontFile(packageRoot)
    expect(resolved).toBe(join(dir, 'Roboto-Regular.ttf'))
  })

  it('prefers the dist-layout asset when both layouts are present', async () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'export-font-'))
    const distDir = join(packageRoot, 'dist', 'assets', 'fonts', 'Roboto')
    const srcDir = join(packageRoot, 'assets', 'fonts', 'Roboto')
    mkdirSync(distDir, { recursive: true })
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(distDir, 'Roboto-Regular.ttf'), 'dist-copy')
    writeFileSync(join(srcDir, 'Roboto-Regular.ttf'), 'stale-src-copy')

    const resolved = await resolveExportFontFile(packageRoot)
    expect(resolved).toBe(join(distDir, 'Roboto-Regular.ttf'))
  })

  it('returns null when neither layout has the asset', async () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'export-font-'))

    const resolved = await resolveExportFontFile(packageRoot)
    expect(resolved).toBeNull()
  })

  it('resolves the real vendored asset from this package root', async () => {
    const resolved = await resolveExportFontFile()
    expect(resolved).not.toBeNull()
  })

  it('the real vendored asset is a valid TTF/OTF opentype.js can parse (not a woff2)', async () => {
    const resolved = await resolveExportFontFile()
    if (!resolved) throw new Error('expected the vendored export font to resolve')
    const font = opentype.parse(readFileSync(resolved))
    expect(font.unitsPerEm).toBeGreaterThan(0)
  })

  it('EXPORT_FONT_FAMILY matches the family name reported by the vendored asset', async () => {
    const resolved = await resolveExportFontFile()
    if (!resolved) throw new Error('expected the vendored export font to resolve')
    const font = opentype.parse(readFileSync(resolved))
    expect(readFontFamilyName(font)).toBe(EXPORT_FONT_FAMILY)
  })
})
