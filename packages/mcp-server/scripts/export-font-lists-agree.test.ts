import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyPackContents } from '../../../tools/checks/src/verify-pack-contents.mjs'
import { resolveExportFontFaces } from '../src/server/export/export-font.js'
import { FONT_DIR_SEGMENTS, FONT_FILES } from './copy-export-font-into-dist.mjs'

// The export faces are named three times: the runtime's `EXPORT_FONT_FILES`,
// the build step's `FONT_FILES`, and the pack gate's required dist paths. A
// face on the runtime list alone still resolves in the repo through the src
// layout and goes missing only from the published tarball, where the export
// silently paints it with Regular — so the lists are held equal here instead.
const FACE_FILES = FONT_FILES.filter((file) => file.endsWith('.ttf')).sort()

describe('the export font faces agree across runtime, build step and pack gate', () => {
  let root: string | undefined

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  it('resolves every runtime face, and only those, from what the build step copies', async () => {
    root = mkdtempSync(join(tmpdir(), 'export-font-lists-agree-'))
    const distDir = join(root, 'dist', ...FONT_DIR_SEGMENTS)
    mkdirSync(distDir, { recursive: true })
    for (const file of FONT_FILES) writeFileSync(join(distDir, file), 'bytes')

    const faces = Object.values(await resolveExportFontFaces(root))

    expect(faces).not.toContain(null)
    expect(faces.map((path) => basename(path ?? '')).sort()).toEqual(FACE_FILES)
  })

  it('requires exactly the copied faces in the packed tarball', () => {
    const result = verifyPackContents([{ files: [], size: 0 }])
    if (!('missing' in result)) throw new Error(`unexpected structural failure: ${result.reason}`)
    const fontDir = `dist/${FONT_DIR_SEGMENTS.join('/')}/`
    const required = result.missing.filter((path) => path.startsWith(fontDir))

    expect(required.map((path) => path.slice(fontDir.length)).sort()).toEqual(FACE_FILES)
  })
})
