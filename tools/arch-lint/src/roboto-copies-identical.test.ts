/**
 * `export-font.ts` claims canvas-viewer's Roboto is a byte-identical copy of
 * mcp-server's, because Node export and the browser must measure text against
 * the same glyph metrics. The two packages cannot import each other, so the
 * agreement rests on two vendored files staying equal; nothing else would
 * notice one being replaced.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from './scan-roots.js'

const FONT_DIR = join('assets', 'fonts', 'Roboto')
const MCP_SERVER_DIR = join(REPO_ROOT, 'packages', 'mcp-server', FONT_DIR)
const CANVAS_VIEWER_DIR = join(REPO_ROOT, 'packages', 'canvas-viewer', FONT_DIR)

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex')

describe('vendored Roboto copies', () => {
  const vendoredByViewer = readdirSync(CANVAS_VIEWER_DIR)

  it('canvas-viewer vendors the Regular face the export measures against', () => {
    expect(vendoredByViewer).toContain('Roboto-Regular.ttf')
  })

  it.each(vendoredByViewer)('%s is byte-identical in canvas-viewer and mcp-server', (file) => {
    expect(sha256(join(CANVAS_VIEWER_DIR, file))).toBe(sha256(join(MCP_SERVER_DIR, file)))
  })
})
