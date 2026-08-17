import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyExportFontIntoDist, FONT_FILES } from './copy-export-font-into-dist.mjs'

describe('copyExportFontIntoDist', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('copies every face byte-identically to the destination', () => {
    dir = mkdtempSync(join(tmpdir(), 'copy-export-font-into-dist-'))
    const srcDir = join(dir, 'assets', 'fonts', 'Roboto')
    const destDir = join(dir, 'dist', 'assets', 'fonts', 'Roboto')
    mkdirSync(srcDir, { recursive: true })
    for (const file of FONT_FILES) writeFileSync(join(srcDir, file), `bytes:${file}`)

    copyExportFontIntoDist(srcDir, destDir)

    for (const file of FONT_FILES) {
      expect(readFileSync(join(destDir, file), 'utf-8')).toBe(`bytes:${file}`)
    }
  })

  it('throws a loud error when any source face is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'copy-export-font-into-dist-'))
    const srcDir = join(dir, 'assets', 'fonts', 'Roboto')
    const destDir = join(dir, 'dist', 'assets', 'fonts', 'Roboto')
    mkdirSync(srcDir, { recursive: true })
    // Regular alone is not enough: the sibling faces are load-bearing too.
    writeFileSync(join(srcDir, 'Roboto-Regular.ttf'), 'bytes')

    expect(() => copyExportFontIntoDist(srcDir, destDir)).toThrow(/export font asset not found/)
  })
})
