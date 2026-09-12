// A themed board's PROSE is themed too. A markdown body draws furniture —
// the code panel, the blockquote rail, a task checkbox, a table's rules —
// and until the palette could say what colour that furniture is, every
// board drew it in one bundled slate while the text around it took the
// theme (package-canvas-render.md decision 15).

import { SAMPLE_THEME_TOKENS, type ThemeTokens } from '@kamiazya/whiteboard-facet-engine'
import type { SpatialCanvas } from '@kamiazya/whiteboard-model'
import { textNode } from '@kamiazya/whiteboard-model/test-utils'
import { VISUAL_THEMES } from '@kamiazya/whiteboard-plugin-visual'
import type { Appearance, Scene, SceneNode } from '@kamiazya/whiteboard-scene'
import { describe, expect, it } from 'vitest'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import { MARKDOWN_THEME_NODE } from '../theme/markdown-theme.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'
import {
  layoutSpatialCanvas,
  type RenderContribution,
  type SpatialLayoutOptions,
} from './spatial-canvas.js'

const THEME_KEY = 'demo.theme/v0'
const CHROME = '#123456'

const themeWith = (markdownChrome: string | undefined): ThemeTokens => ({
  ...SAMPLE_THEME_TOKENS,
  ink: 'clean',
  palette: {
    ...SAMPLE_THEME_TOKENS.palette,
    light: {
      ...SAMPLE_THEME_TOKENS.palette.light,
      ...(markdownChrome === undefined ? {} : { markdownChrome }),
    },
  },
})

const DEMO: RenderContribution = {
  namespace: 'demo',
  themes: { inked: themeWith(CHROME), plain: themeWith(undefined) },
  readTheme: (canvas) => {
    const stored = canvas.facets?.[THEME_KEY]
    return typeof stored === 'object' && stored !== null
      ? (stored as { theme?: string }).theme
      : undefined
  },
}

// One body carrying three pieces of furniture: a filled panel, a rail, and
// the one stroked mark in a markdown body.
const BODY = ['> quoted', '', '```js', 'const a = 1', '```', '', '- [ ] todo'].join('\n')

const boardIn = (theme: string | undefined, key = THEME_KEY): SpatialCanvas => ({
  nodes: [textNode({ id: 'a', x: 0, y: 0, width: 320, height: 400, text: BODY })],
  edges: [],
  ...(theme === undefined ? {} : { facets: { [key]: { theme } } }),
})

function options(over?: Partial<SpatialLayoutOptions>): SpatialLayoutOptions {
  return {
    measure: createFakeMeasure(),
    appearance: createSpatialTheme({ mode: 'light' }),
    renderContributions: [DEMO],
    ...over,
  }
}

function everyNode(nodes: readonly SceneNode[]): readonly SceneNode[] {
  return nodes.flatMap((node) => {
    const nested: readonly SceneNode[] =
      node.kind === 'list'
        ? node.items.flatMap((item) => item.children)
        : 'children' in node
          ? node.children
          : []
    return [node, ...everyNode(nested)]
  })
}

const appearanceOf = (node: SceneNode | undefined): Appearance | undefined =>
  node !== undefined && 'appearance' in node ? node.appearance : undefined

const find = (scene: Scene, kind: SceneNode['kind']) =>
  everyNode(scene.nodes).filter((node) => node.kind === kind)

/** The code fence's panel: the one filled surface a body paints. */
const panelFill = (scene: Scene) => appearanceOf(find(scene, 'codeBlock')[0])?.fill
/** The blockquote's rail — the bar is the quote's first child. */
const railFill = (scene: Scene) => {
  const quote = find(scene, 'blockquote')[0]
  return appearanceOf(quote !== undefined && 'children' in quote ? quote.children[0] : undefined)
    ?.fill
}
/**
 * The task checkbox's outline — the one STROKED paint a markdown body draws,
 * and the only shape in the scene carrying a stroke opacity, which is what
 * tells it apart from the node's own chrome.
 */
const checkboxStroke = (scene: Scene) =>
  find(scene, 'shape')
    .map(appearanceOf)
    .find((appearance) => appearance?.strokeOpacity !== undefined)?.stroke

describe("a theme's palette reaches the markdown body's furniture", () => {
  it('paints the code panel, the blockquote rail and the checkbox in the palette chrome', () => {
    const scene = layoutSpatialCanvas(boardIn('demo.inked'), options({ style: 'document' }))
    expect(panelFill(scene)).toBe(CHROME)
    expect(railFill(scene)).toBe(CHROME)
    expect(checkboxStroke(scene)).toBe(CHROME)
  })

  it('reaches a real board through the bundled plugin, with no composition-root wiring', () => {
    // The DEFAULT contribution set, as an editor, a thumbnail and an export
    // all use it: `visual.sketch`'s own warm pencil grey, not the slate.
    const scene = layoutSpatialCanvas(
      boardIn('visual.sketch', 'visual.theme/v0'),
      options({ style: 'document', renderContributions: undefined }),
    )
    expect(panelFill(scene)).toBe(VISUAL_THEMES.sketch.palette.light.markdownChrome)
    expect(panelFill(scene)).not.toBe(MARKDOWN_THEME_NODE.chromeColor)
  })

  it('keeps the bundled neutral for a theme that declares no chrome, and for no theme at all', () => {
    const slate = MARKDOWN_THEME_NODE.chromeColor
    for (const scene of [
      layoutSpatialCanvas(boardIn('demo.plain'), options({ style: 'document' })),
      layoutSpatialCanvas(boardIn(undefined), options({ style: 'document' })),
      layoutSpatialCanvas(boardIn('demo.inked'), options()),
    ]) {
      expect(panelFill(scene)).toBe(slate)
      expect(railFill(scene)).toBe(slate)
      expect(checkboxStroke(scene)).toBe(slate)
    }
  })
})
