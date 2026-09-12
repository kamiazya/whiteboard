// @vitest-environment node
// Every host that installs the shortcode source must ALSO pass the row
// renderer, and forgetting one is silent: the popup still opens and still
// inserts the right text, it just draws no glyph — on that host only.
//
// A browser test cannot see this. It builds its own EditorView and passes the
// renderer itself, so it asserts the renderer WORKS and never that anyone
// hands it over: measured, deleting `addToOptions` from MarkdownEditor left
// all seven browser cases green. That is the shape `test-layer-selection`
// names — the assertion is right and the subject is absent from the fixture.
//
// `?raw` at build time rather than `node:fs`: apps/web is browser-only (see
// web-app-boundary.test.ts).

import { describe, expect, it } from 'vitest'
import spatialSource from '../spatial-editor/MarkdownNodeEditor.tsx?raw'
import markdownSource from './MarkdownEditor.tsx?raw'

const HOSTS = [
  { name: 'MarkdownEditor.tsx', source: markdownSource },
  { name: 'MarkdownNodeEditor.tsx', source: spatialSource },
]

describe('every host that offers shortcodes draws their glyphs', () => {
  it('passes the renderer beside the source', () => {
    // A host list that stopped matching would make this vacuous.
    const installing = HOSTS.filter((host) => host.source.includes('shortcodeCompletionSource'))
    expect(installing.map((host) => host.name)).toEqual(HOSTS.map((host) => host.name))

    const missing = installing
      .filter((host) => !host.source.includes('addToOptions: shortcodeOptionRenderers'))
      .map((host) => host.name)
    expect(missing).toEqual([])
  })
})
