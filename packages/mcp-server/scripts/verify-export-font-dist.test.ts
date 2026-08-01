import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findMissingExportFont } from './verify-export-font-dist.mjs'

describe('findMissingExportFont', () => {
  let packageRoot: string | undefined

  afterEach(() => {
    if (packageRoot) rmSync(packageRoot, { recursive: true, force: true })
    packageRoot = undefined
  })

  it('reports nothing missing when dist/assets/fonts/Roboto/Roboto-Regular.ttf exists', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'verify-export-font-dist-'))
    mkdirSync(join(packageRoot, 'dist', 'assets', 'fonts', 'Roboto'), { recursive: true })
    writeFileSync(
      join(packageRoot, 'dist', 'assets', 'fonts', 'Roboto', 'Roboto-Regular.ttf'),
      'fake-ttf-bytes',
    )

    expect(findMissingExportFont(packageRoot)).toBeNull()
  })

  it('reports the missing font path when the copy step never ran', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'verify-export-font-dist-'))

    const missing = findMissingExportFont(packageRoot)
    expect(missing).toBe(
      join(packageRoot, 'dist', 'assets', 'fonts', 'Roboto', 'Roboto-Regular.ttf'),
    )
  })
})
