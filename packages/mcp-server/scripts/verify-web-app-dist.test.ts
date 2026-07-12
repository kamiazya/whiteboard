import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findMissingWebAppDistIndex } from './verify-web-app-dist.mjs'

describe('findMissingWebAppDistIndex', () => {
  let packageRoot: string | undefined

  afterEach(() => {
    if (packageRoot) rmSync(packageRoot, { recursive: true, force: true })
    packageRoot = undefined
  })

  it('reports nothing missing when dist/web-app/index.html exists', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'verify-web-app-dist-'))
    mkdirSync(join(packageRoot, 'dist', 'web-app'), { recursive: true })
    writeFileSync(join(packageRoot, 'dist', 'web-app', 'index.html'), '<html></html>')

    expect(findMissingWebAppDistIndex(packageRoot)).toBeNull()
  })

  it('reports the missing index.html path when the copy step never ran', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'verify-web-app-dist-'))

    const missing = findMissingWebAppDistIndex(packageRoot)
    expect(missing).toBe(join(packageRoot, 'dist', 'web-app', 'index.html'))
  })
})
