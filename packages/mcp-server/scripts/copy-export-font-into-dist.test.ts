import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyExportFontIntoDist } from './copy-export-font-into-dist.mjs'

describe('copyExportFontIntoDist', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('copies the font asset byte-identically to the destination', () => {
    dir = mkdtempSync(join(tmpdir(), 'copy-export-font-into-dist-'))
    const src = join(dir, 'assets', 'fonts', 'Roboto', 'Roboto-Regular.ttf')
    const dest = join(dir, 'dist', 'assets', 'fonts', 'Roboto', 'Roboto-Regular.ttf')
    mkdirSync(join(dir, 'assets', 'fonts', 'Roboto'), { recursive: true })
    writeFileSync(src, 'fake-ttf-bytes')

    copyExportFontIntoDist(src, dest)

    expect(readFileSync(dest, 'utf-8')).toBe('fake-ttf-bytes')
  })

  it('throws a loud error when the source font asset is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'copy-export-font-into-dist-'))
    const src = join(dir, 'assets', 'fonts', 'Roboto', 'Roboto-Regular.ttf')
    const dest = join(dir, 'dist', 'assets', 'fonts', 'Roboto', 'Roboto-Regular.ttf')

    expect(() => copyExportFontIntoDist(src, dest)).toThrow(/export font asset not found/)
  })
})
