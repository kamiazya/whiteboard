// The family an export DECLARES and the face it MEASURED with are one
// decision (ADR-0030 decision 9). A user-installed face (ADR-0012) is what
// lets a theme's family be declared at all, so it is also what has to supply
// the advances: a run measured with the vendored Roboto and painted in
// Yomogi wraps where nothing in the picture says it should.
//
// Its own file because the exporter warms one face set per process: the font
// is installed before the first export here, which is the state a daemon is
// in when a user has installed one.

import { mkdtempSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resetDataDirForTests, setDataDirForTests } from '../../shared/data-dir-secure.js'
import { syntheticFont } from '../../shared/test-utils/synthetic-font.js'
import { renderSpatialCanvasToSvg } from './headless-renderer.js'
import { installedFontDir } from './installed-fonts.js'

// Three tokens that fit one 200px-wide node when measured in Roboto and do
// not when measured in the installed face, whose every glyph is a full em.
const TEXT = 'xxxx xxxx xxxx'

const sketched: SpatialCanvas = {
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 200, height: 200, text: TEXT })],
  edges: [],
  facets: { 'visual.theme/v0': { theme: 'visual.sketch' } },
}

const lines = (svg: string): string[] =>
  [...svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((match) => match[1])

describe('a theme font the user installed', () => {
  beforeAll(async () => {
    setDataDirForTests(mkdtempSync(join(tmpdir(), 'wb-export-face-')))
    await mkdir(installedFontDir(), { recursive: true })
    await writeFile(join(installedFontDir(), 'yomogi.ttf'), syntheticFont(TEXT, 'Yomogi'))
  })

  afterAll(() => {
    resetDataDirForTests()
  })

  it('is declared and measured by the same face, so the runs wrap where they are painted', async () => {
    const sketch = await renderSpatialCanvasToSvg(sketched, { style: 'document' })
    expect(sketch.svg).toContain('font-family="Yomogi"')
    expect(sketch.unresolvedFamilies).toEqual([])
    // A full em per glyph: two tokens fit the node's text width, three do not.
    expect(lines(sketch.svg)).toEqual(['xxxx xxxx', 'xxxx'])
  })

  it('leaves a clean export measured and declared in the bundled family', async () => {
    const clean = await renderSpatialCanvasToSvg(sketched)
    expect(clean.svg).toContain('font-family="Roboto"')
    expect(lines(clean.svg)).toEqual([TEXT])
  })
})
