import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findMissingWidgetHtml } from './verify-widget-dist.mjs'

describe('findMissingWidgetHtml', () => {
  let packageRoot: string | undefined

  afterEach(() => {
    if (packageRoot) rmSync(packageRoot, { recursive: true, force: true })
    packageRoot = undefined
  })

  it('reports nothing missing when dist/widget/canvas-viewer.html exists', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'verify-widget-dist-'))
    mkdirSync(join(packageRoot, 'dist', 'widget'), { recursive: true })
    writeFileSync(join(packageRoot, 'dist', 'widget', 'canvas-viewer.html'), '<html></html>')

    expect(findMissingWidgetHtml(packageRoot)).toBeNull()
  })

  it('reports the missing canvas-viewer.html path when the copy step never ran', () => {
    packageRoot = mkdtempSync(join(tmpdir(), 'verify-widget-dist-'))

    const missing = findMissingWidgetHtml(packageRoot)
    expect(missing).toBe(join(packageRoot, 'dist', 'widget', 'canvas-viewer.html'))
  })
})
