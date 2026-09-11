// The `theme` glyph arm: registered geometry drawn the way a registered
// theme draws it. A synthetic plugin, like every test here — this package is
// the library a plugin builds on, and reaching for the bundled one could not
// tell a library defect from that plugin's declaration.
import type { ThemeTokensInput } from '@kamiazya/whiteboard-facet-engine'
import {
  createFacetRegistry,
  definePlugin,
  SAMPLE_THEME_TOKENS,
} from '@kamiazya/whiteboard-facet-engine'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { glyphIcon } from './glyph.js'

afterEach(cleanup)

// The engine's own complete fixture, so this test authors no palette — what
// it varies is `ink` and `glow`, which is all this arm reads.
const theme = (tokens: Partial<ThemeTokensInput>): ThemeTokensInput => ({
  ...SAMPLE_THEME_TOKENS,
  ink: 'clean',
  glow: undefined,
  ...tokens,
})

const registry = createFacetRegistry([
  definePlugin({
    id: 'demo',
    displayName: 'Demo',
    facets: [],
    assets: {
      icons: { mark: { viewBox: '0 0 88 56', geometry: [{ tag: 'path', d: 'M4 40 L84 16' }] } },
      themes: {
        plain: theme({}),
        hand: theme({ ink: 'sketch' }),
        lit: theme({ glow: { radiusPx: 6 } }),
      },
    },
  }),
])

function draw(themeId: string): SVGElement {
  const { container } = render(
    <span>{glyphIcon({ kind: 'theme', id: themeId, icon: 'demo.mark' }, registry)}</span>,
  )
  const svg = container.querySelector('svg')
  expect(svg).not.toBeNull()
  return svg as SVGElement
}

it("takes the specimen's own view box, so a mark drawn outside the 24-grid is not squeezed", () => {
  expect(draw('demo.plain').getAttribute('viewBox')).toBe('0 0 88 56')
})

/**
 * The three themes must not draw the same picture. That is the whole reason
 * this arm exists: `asset` renders one flat stroke in `currentColor`, so a
 * row of themes drawn through it is one picture repeated, and the option a
 * person is choosing between looks identical to its neighbours.
 */
it('draws a different number of passes per theme, so two themes never look alike', () => {
  const passes = (themeId: string) => draw(themeId).querySelectorAll('path').length
  // Plain: the stroke alone. Sketch: a nudged second pass, the way the
  // renderer lays a jittered one over the first. Glow: a wide faint copy
  // underneath, standing in for the halo a blur draws at canvas scale.
  expect(passes('demo.plain')).toBe(1)
  expect(passes('demo.hand')).toBe(2)
  expect(passes('demo.lit')).toBe(2)
})

it('separates sketch from glow by HOW the extra pass is drawn, not only that there is one', () => {
  const extraOf = (themeId: string) => {
    const group = draw(themeId).querySelector('g')
    expect(group).not.toBeNull()
    return group as SVGElement
  }
  // Sketch offsets; glow widens. Two passes each, and nothing else in the
  // markup would tell them apart.
  expect(extraOf('demo.hand').getAttribute('transform')).toBeTruthy()
  expect(extraOf('demo.hand').getAttribute('stroke-width')).toBeNull()
  expect(extraOf('demo.lit').getAttribute('transform')).toBeNull()
  expect(Number(extraOf('demo.lit').getAttribute('stroke-width'))).toBeGreaterThan(
    Number(draw('demo.lit').getAttribute('stroke-width')),
  )
})

/**
 * An id this build does not carry is DATA, not an error — the same
 * degradation `asset` makes. A deployment that registers neither the theme
 * nor the specimen still draws the option, with its word.
 */
it('answers nothing for an unregistered theme or specimen, rather than throwing', () => {
  expect(glyphIcon({ kind: 'theme', id: 'demo.nope', icon: 'demo.mark' }, registry)).toBeUndefined()
  expect(
    glyphIcon({ kind: 'theme', id: 'demo.plain', icon: 'demo.nope' }, registry),
  ).toBeUndefined()
  expect(glyphIcon({ kind: 'theme', id: 'demo.plain', icon: 'demo.mark' })).toBeUndefined()
})
