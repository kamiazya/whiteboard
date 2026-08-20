// ADR-0011 decided fonts beyond the Latin default are installed rather than
// bundled; ADR-0012 decided the daemon keeps them as files. This is the read
// side of both: whatever is in the data directory participates in export.
//
// Deliberately a plain directory rather than a manifest. A user who drops a
// TTF in has installed a font, and a mechanism that only recognises its own
// downloads would refuse the simplest way to answer "my exports are tofu".

import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import { syntheticFont } from '../../shared/test-utils/synthetic-font.js'
import { installedFontDir, installedFontFiles } from './installed-fonts.js'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wb-fonts-'))
  setDataDirForTests(dataDir)
})

afterEach(() => {
  resetDataDirForTests()
})

describe('installedFontFiles', () => {
  it('is empty when nothing has been installed', async () => {
    expect(await installedFontFiles()).toEqual([])
  })

  it('is empty when the directory does not exist at all', async () => {
    setDataDirForTests(join(dataDir, 'nope'))

    // A daemon that has never installed a font must export exactly as before,
    // not fail because a directory is missing.
    expect(await installedFontFiles()).toEqual([])
  })

  it('finds font files a user dropped in, sorted for reproducibility', async () => {
    await mkdir(installedFontDir(), { recursive: true })
    for (const name of ['zeta.ttf', 'alpha.otf', 'beta.ttc']) {
      await writeFile(join(installedFontDir(), name), 'not really a font')
    }

    expect(await installedFontFiles()).toEqual([
      join(installedFontDir(), 'alpha.otf'),
      join(installedFontDir(), 'beta.ttc'),
      join(installedFontDir(), 'zeta.ttf'),
    ])
  })

  it('ignores anything that is not a font file', async () => {
    await mkdir(installedFontDir(), { recursive: true })
    await writeFile(join(installedFontDir(), 'notes.txt'), 'x')
    await writeFile(join(installedFontDir(), '.DS_Store'), 'x')
    await writeFile(join(installedFontDir(), 'real.ttf'), 'x')

    expect(await installedFontFiles()).toEqual([join(installedFontDir(), 'real.ttf')])
  })
})

/**
 * The report and the render have to read the same set, or the report is about
 * a picture nobody produced. This is ADR-0011 decision 4 at the one place it
 * can actually be checked: install a face that covers the text, and both the
 * pixels and the `undrawable` answer must change together.
 *
 * The face is SYNTHESISED rather than copied from the machine. An earlier
 * version read `/usr/share/fonts/...` and skipped when absent — which on CI is
 * always, since no job installs a CJK font. Both assertions below were
 * therefore green and had never run. A test that needs a glyph can make one.
 */
describe('an installed font reaches both the renderer and the report', () => {
  const COVERED = 'こ'

  const writeSyntheticFont = (path: string): Promise<void> =>
    writeFile(path, syntheticFont(COVERED))

  const CANVAS = {
    nodes: [{ id: 'n', type: 'text' as const, x: 0, y: 0, width: 300, height: 60, text: COVERED }],
    edges: [],
  }

  it('stops reporting characters it can now draw', async () => {
    const { undrawableCharacters } = await import('./undrawable-characters.js')
    expect(await undrawableCharacters(CANVAS)).toEqual([COVERED])

    await mkdir(installedFontDir(), { recursive: true })
    await writeSyntheticFont(join(installedFontDir(), 'covered.ttf'))

    expect(await undrawableCharacters(CANVAS)).toEqual([])
  })

  // The report changing is NOT evidence the picture did: they are wired
  // separately, and a version that fixed only the report passed the test
  // above unchanged. resvg is the half a user actually sees, so it gets its
  // own assertion — on the PIXELS, since that is the only place the answer
  // exists.
  it('renders glyphs the vendored face lacks', async () => {
    const { renderSpatialCanvasToPng } = await import('./headless-renderer.js')
    const tofu = await renderSpatialCanvasToPng(CANVAS, { theme: 'light' })

    await mkdir(installedFontDir(), { recursive: true })
    await writeSyntheticFont(join(installedFontDir(), 'covered.ttf'))
    const drawn = await renderSpatialCanvasToPng(CANVAS, { theme: 'light' })

    // Same canvas, same size, different ink. Byte equality would mean resvg
    // painted the identical tofu box — which is exactly what happens when the
    // installed files never reach `fontFiles`.
    expect(drawn.width).toBe(tofu.width)
    expect(drawn.height).toBe(tofu.height)
    expect(drawn.png.equals(tofu.png)).toBe(false)
  })
})
