import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FONT_FILES } from './copy-export-font-into-dist.mjs'
import { findMissingExportFont } from './verify-export-font-dist.mjs'

describe('findMissingExportFont', () => {
  let packageRoot: string | undefined

  afterEach(() => {
    if (packageRoot) rmSync(packageRoot, { recursive: true, force: true })
    packageRoot = undefined
  })

  it('reports nothing missing when every dist face exists — and Regular alone is not enough', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'verify-export-font-dist-'))
    const dir = join(packageRoot, 'dist', 'assets', 'fonts', 'Roboto')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'Roboto-Regular.ttf'), 'fake-ttf-bytes')
    // The sibling faces are load-bearing (measured bold must paint bold).
    expect(findMissingExportFont(packageRoot)).toContain('Roboto-Bold.ttf')
    for (const file of FONT_FILES) writeFileSync(join(dir, file), 'fake-ttf-bytes')
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
