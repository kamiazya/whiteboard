// @vitest-environment node
/**
 * Real-engine smoke for the MathJax half of the fragment renderers: the
 * dynamic-import wiring is exactly the class of failure a mocked test
 * cannot see (a subpath that resolves in dev and breaks in the production
 * bundle, or vice versa), so this renders genuine TeX through the genuine
 * engine. The mermaid half needs a real DOM and is smoked in
 * markdown-fragment-renderers.browser.test.tsx instead.
 */
import { describe, expect, it } from 'vitest'
import { FRAGMENT_ENGINES, fragmentIsEmbeddable } from './markdown-fragment-renderers.js'

const { math: renderMathFragment, diagram: renderDiagramFragment } = FRAGMENT_ENGINES

describe('renderMathFragment (real MathJax)', () => {
  it('renders TeX to a sized SVG fragment', async () => {
    const fragment = await renderMathFragment('x^2 + y^2 = z^2')
    expect(fragment).toBeDefined()
    expect(fragment?.svg).toMatch(/^<svg/)
    expect(fragment?.svg).toContain('</svg>')
    expect(fragment?.width).toBeGreaterThan(0)
    expect(fragment?.height).toBeGreaterThan(0)
  })

  // A `$$` block is DISPLAY math: a sum's limits stack above and below it
  // rather than sitting beside it, so the same source typeset in text style
  // is measurably shorter. `\textstyle` is the engine's own text style, an
  // oracle independent of the option under test.
  it('typesets in display style, stacking limits above and below a sum', async () => {
    const display = await renderMathFragment('\\sum_{i=0}^{n} i')
    const text = await renderMathFragment('\\textstyle\\sum_{i=0}^{n} i')
    expect(display?.height).toBeGreaterThan(text?.height ?? Number.POSITIVE_INFINITY)
  })

  it('is total against TeX the engine rejects outright', async () => {
    // MathJax renders most malformed TeX as an error node, and this
    // module's own guards map anything else to undefined — totality here
    // means "resolves, never rejects", with either answer valid.
    await expect(renderMathFragment('\\undefinedmacro{')).resolves.not.toThrow
    const fragment = await renderMathFragment('\\undefinedmacro{')
    if (fragment !== undefined) expect(fragment.svg).toMatch(/^<svg/)
  })

  it('never emits a fragment carrying a non-local href (TeX \\href is rejected)', async () => {
    // AllPackages minus `html` plus the output-side guard: whichever layer
    // catches it, no attacker-controlled URL may survive into SVG this app
    // injects verbatim.
    const fragment = await renderMathFragment('\\href{javascript:alert(1)}{x}')
    if (fragment !== undefined) {
      expect(fragment.svg).not.toContain('javascript:')
      for (const match of fragment.svg.matchAll(/href\s*=\s*"([^"]*)"/gi)) {
        expect(match[1]?.startsWith('#')).toBe(true)
      }
    }
  })

  // The fragment lands in the app's own DOM, so an id from document text
  // could clobber a global and a class could borrow the app's CSS; neither
  // trips the href check, so the macros must not exist at all.
  it('gives document text no way to set an id, class or style', async () => {
    const id = await renderMathFragment('\\cssId{wbinjectedid}{y}')
    expect(id?.svg ?? '').not.toContain('wbinjectedid')
    const cls = await renderMathFragment('\\class{wbinjectedclass}{y}')
    expect(cls?.svg ?? '').not.toContain('wbinjectedclass')
    const style = await renderMathFragment('\\style{outline:9px solid}{y}')
    expect(style?.svg ?? '').not.toContain('outline')
  })

  // `\require` loads a package at typeset time, and its default allow list
  // admits `html` — so excluding the package from the list is not enough on
  // its own.
  it('gives \\require no way to load the html package back', async () => {
    const id = await renderMathFragment('\\require{html}\\cssId{wbreqid}{y}')
    expect(id?.svg ?? '').not.toContain('wbreqid')
    const cls = await renderMathFragment('\\require{html}\\class{wbreqclass}{y}')
    expect(cls?.svg ?? '').not.toContain('wbreqclass')
    const style = await renderMathFragment('\\require{html}\\style{outline:9px solid}{y}')
    expect(style?.svg ?? '').not.toContain('outline')
    const href = await renderMathFragment('\\require{html}\\href{https://evil.example}{y}')
    expect(href?.svg ?? '').not.toContain('evil.example')
  })

  // `\unicode[font]{n}` writes its optional font argument into the glyph's
  // style, which is document text choosing CSS.
  it('gives \\unicode no way to name a font', async () => {
    const fragment = await renderMathFragment('\\unicode[wbinjectedfont]{x41}')
    expect(fragment?.svg ?? '').not.toContain('wbinjectedfont')
  })

  // `\bbox[…]` passes any `name: value` part of its option through as the
  // box's inline style — `\style` by another name.
  it('gives \\bbox no way to write an inline style', async () => {
    const fragment = await renderMathFragment('\\bbox[outline:9px solid red]{x}')
    expect(fragment?.svg ?? '').not.toContain('outline')
  })

  // The base package's `\mmlToken{kind}[attrs]{text}` copies its attribute
  // list onto the MathML node, which the SVG output writes out — the html
  // package's id, class and style by another door.
  it('gives \\mmlToken no way to set an id, class, style or href', async () => {
    const attrs = await renderMathFragment(
      '\\mmlToken{mi}[id="wbmmlid",class="wbmmlclass",style="color:red"]{a}',
    )
    // Typeset with the attributes dropped, not refused outright.
    expect(attrs?.svg).toContain('data-mml-node="mi"')
    expect(attrs?.svg ?? '').not.toContain('wbmmlid')
    expect(attrs?.svg ?? '').not.toContain('wbmmlclass')
    expect(attrs?.svg ?? '').not.toContain('color:red')
    const href = await renderMathFragment('\\mmlToken{mi}[href="https://wbmml.example"]{a}')
    expect(href?.svg ?? '').not.toContain('wbmml.example')
  })

  it("keeps a token's own MathML attributes from \\mmlToken", async () => {
    const coloured = await renderMathFragment('\\mmlToken{mi}[mathcolor="red"]{a}')
    expect(coloured?.svg).toContain('fill="red"')
  })

  // A macro defined in the document reaches the same node through a name
  // the source never spells as `\mmlToken`.
  it('gives a macro wrapping \\mmlToken no way to set an id', async () => {
    const viaDef = await renderMathFragment('\\def\\t{\\mmlToken{mi}[id="wbdefid"]{a}}\\t')
    expect(viaDef?.svg ?? '').not.toContain('wbdefid')
    const viaNew = await renderMathFragment('\\newcommand{\\t}{\\mmlToken{mi}[id="wbnewid"]{a}}\\t')
    expect(viaNew?.svg ?? '').not.toContain('wbnewid')
    const viaChoice = await renderMathFragment(
      '\\mathchoice{\\mmlToken{mi}[id="wbchoiceid"]{a}}{a}{a}{a}',
    )
    expect(viaChoice?.svg ?? '').not.toContain('wbchoiceid')
  })

  // A self-referential macro is bounded by the engine's macro and buffer
  // limits; document text must not be able to raise them.
  it('stays total against unbounded macro recursion', async () => {
    const def = await renderMathFragment('\\def\\x{\\x\\x}\\x')
    if (def !== undefined) expect(def.svg).toMatch(/^<svg/)
    const raised = await renderMathFragment(
      '\\setOptions{tex}{maxMacros=100000000,maxBuffer=100000000}\\def\\x{\\x\\x}\\x',
    )
    if (raised !== undefined) expect(raised.svg).toMatch(/^<svg/)
  })
})

describe('renderDiagramFragment', () => {
  it('declines every non-mermaid language without loading an engine', async () => {
    await expect(renderDiagramFragment('ts', 'const x = 1')).resolves.toBeUndefined()
  })
})

describe('fragmentIsEmbeddable', () => {
  it('accepts a fragment whose only references are local', () => {
    expect(fragmentIsEmbeddable('<svg><use href="#g1"/><text>on=1 onclick=x</text></svg>')).toBe(
      true,
    )
  })

  it('refuses a non-local href', () => {
    expect(fragmentIsEmbeddable('<svg><a href="javascript:alert(1)">x</a></svg>')).toBe(false)
  })

  it('refuses a script element in any case', () => {
    expect(fragmentIsEmbeddable('<svg><script>alert(1)</script></svg>')).toBe(false)
    expect(fragmentIsEmbeddable('<svg><SCRIPT>alert(1)</SCRIPT></svg>')).toBe(false)
  })

  it('refuses an event-handler attribute in any case', () => {
    expect(fragmentIsEmbeddable('<svg><rect onclick="alert(1)"/></svg>')).toBe(false)
    expect(fragmentIsEmbeddable('<svg ONLOAD="alert(1)"></svg>')).toBe(false)
    expect(fragmentIsEmbeddable("<svg><rect\nonmouseover = 'x'/></svg>")).toBe(false)
    // A `>` inside an earlier quoted value does not end the tag.
    expect(fragmentIsEmbeddable('<svg><rect style="a>b" onclick="x"/></svg>')).toBe(false)
  })
})

describe('fragmentIsEmbeddable refuses live HTML and remote loads', () => {
  it('refuses a foreignObject in any case', () => {
    expect(fragmentIsEmbeddable('<svg><foreignObject><div>x</div></foreignObject></svg>')).toBe(
      false,
    )
    expect(fragmentIsEmbeddable('<svg><FOREIGNOBJECT/></svg>')).toBe(false)
  })

  it('refuses a form element and a form-submitting attribute', () => {
    expect(fragmentIsEmbeddable('<svg><form><input name="q"/></form></svg>')).toBe(false)
    expect(fragmentIsEmbeddable('<svg><g action="https://evil.example"/></svg>')).toBe(false)
    expect(fragmentIsEmbeddable("<svg><g FormAction = 'https://evil.example'/></svg>")).toBe(false)
  })

  it('refuses a non-local src and accepts a local one', () => {
    expect(fragmentIsEmbeddable('<svg><image src="https://evil.example/p.png"/></svg>')).toBe(false)
    expect(fragmentIsEmbeddable('<svg><image src=data:image/png;base64,AA/></svg>')).toBe(false)
    expect(fragmentIsEmbeddable('<svg><g src="#local"/></svg>')).toBe(true)
  })

  it('refuses a non-local url() and accepts a fragment-local one', () => {
    expect(
      fragmentIsEmbeddable('<svg><style>g{background:url(https://evil.example)}</style></svg>'),
    ).toBe(false)
    expect(fragmentIsEmbeddable('<svg><rect style="fill: URL( \'//evil.example\' )"/></svg>')).toBe(
      false,
    )
    expect(
      fragmentIsEmbeddable(
        '<svg><path marker-end="url(#arrow)"/><rect fill="url( \'#g\' )"/></svg>',
      ),
    ).toBe(true)
  })

  it('reads attributes only inside tags, so label text naming them is accepted', () => {
    expect(
      fragmentIsEmbeddable(
        '<svg><text>&lt;form action="https://x"&gt; formaction=y src=z</text></svg>',
      ),
    ).toBe(true)
  })
})

// An exported SVG opened on its own has no CSP, so what a fragment can do
// without script still matters: SMIL can rewrite an attribute (an href) after
// every check here has read it, and an unquoted href value is still a link.
describe('fragmentIsEmbeddable refuses animation and unquoted links', () => {
  it.each([
    '<svg><animate attributeName="href" to="javascript:alert(1)"/></svg>',
    '<svg><set attributeName="href" to="https://evil.example"/></svg>',
    '<svg><ANIMATEMOTION dur="1s"/></svg>',
    '<svg><animateTransform attributeName="transform"/></svg>',
    '<svg><a><Set\nattributeName="href"/></a></svg>',
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:set attributeName="href"/></svg>',
  ])('refuses the animation element in %j', (svg) => {
    expect(fragmentIsEmbeddable(svg)).toBe(false)
  })

  it('reads label text naming an animation element as text', () => {
    expect(fragmentIsEmbeddable('<svg><text>set animate &lt;set</text><settings/></svg>')).toBe(
      true,
    )
  })

  it.each([
    '<svg><a href=javascript:alert(1)>x</a></svg>',
    '<svg><a xlink:href=https://evil.example>x</a></svg>',
    '<svg><use HREF = //evil.example/x.svg#a /></svg>',
    '<svg xmlns:x="http://www.w3.org/1999/xlink"><a x:href=https://evil.example>x</a></svg>',
  ])('refuses the unquoted non-local href in %j', (svg) => {
    expect(fragmentIsEmbeddable(svg)).toBe(false)
  })

  it('accepts an unquoted fragment-local href', () => {
    expect(fragmentIsEmbeddable('<svg><use href=#g1 /><use xlink:href=#g2></use></svg>')).toBe(true)
  })
})

// A standalone SVG is parsed as XML, where any prefix bound to the SVG
// namespace names the same element, so the element checks read through one.
describe('fragmentIsEmbeddable reads through a namespace prefix', () => {
  it.each([
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject/></svg>',
  ])('refuses %j', (svg) => {
    expect(fragmentIsEmbeddable(svg)).toBe(false)
  })
})

// The `url(` check reads raw text, and CSS lets `u\72l(` spell the same
// function and `@import "…"` load a sheet with no `url(` at all. Neither
// engine writes a backslash into CSS — a style attribute or a `<style>`
// element — or an `@import` anywhere.
describe('fragmentIsEmbeddable refuses CSS the url( check cannot read', () => {
  it.each([
    '<svg><rect style="fill: u\\72l(https://evil.example/x)"/></svg>',
    "<svg><rect style='background:\\75rl(//evil.example)'/></svg>",
    '<svg><rect style="@import \'https://evil.example/x.css\'"/></svg>',
    '<svg><style>@import "https://evil.example/x.css";</style></svg>',
    '<svg><style>@IMPORT "//evil.example/x.css";</style></svg>',
    '<svg><style>g{background:u\\72l(https://evil.example/x)}</style></svg>',
    '<svg><STYLE type="text/css">.a{fill:\\75rl(//evil.example)}</STYLE></svg>',
    '<svg><svg:style>g{background:u\\72l(//evil.example)}</svg:style></svg>',
  ])('refuses %j', (svg) => {
    expect(fragmentIsEmbeddable(svg)).toBe(false)
  })

  it('accepts an ordinary inline style, and label text naming @import', () => {
    expect(
      fragmentIsEmbeddable(
        '<svg style="vertical-align: -0.023ex;"><text>@import and a \\ backslash</text></svg>',
      ),
    ).toBe(true)
  })
})
