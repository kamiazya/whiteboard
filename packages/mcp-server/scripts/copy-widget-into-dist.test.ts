import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyWidgetIntoDist } from './copy-widget-into-dist.mjs'

describe('copyWidgetIntoDist', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('copies the widget HTML byte-identically to the destination', () => {
    dir = mkdtempSync(join(tmpdir(), 'copy-widget-into-dist-'))
    const src = join(dir, 'src', 'canvas-viewer.html')
    const dest = join(dir, 'dist', 'widget', 'canvas-viewer.html')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(src, '<html><body>widget</body></html>')

    copyWidgetIntoDist(src, dest)

    expect(readFileSync(dest, 'utf-8')).toBe('<html><body>widget</body></html>')
  })

  it('throws a loud error when the source widget build is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'copy-widget-into-dist-'))
    const src = join(dir, 'src', 'canvas-viewer.html')
    const dest = join(dir, 'dist', 'widget', 'canvas-viewer.html')

    expect(() => copyWidgetIntoDist(src, dest)).toThrow(
      /canvas-viewer widget build output not found/,
    )
  })
})
