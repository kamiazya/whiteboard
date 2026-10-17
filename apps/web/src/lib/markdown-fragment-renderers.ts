/**
 * The composition-root implementations behind canvas-render's `renderMath` /
 * `renderDiagram` seams: MathJax for TeX math, mermaid for diagram fences.
 *
 * Both engines are DYNAMICALLY imported on first use and cached as module
 * singletons — they are far too heavy for the initial chunk, and a document
 * with no math or diagrams must never pay for them. Both functions are
 * total: any engine failure (bad TeX, invalid diagram source, an engine
 * that cannot load) resolves to `undefined`, which the caller caches as a
 * terminal miss so the layout keeps its documented fallback (escaped-source
 * placeholder for math, plain code block for a fence).
 *
 * Trust note (the PreviewPane injection rationale): the returned `svg`
 * string is emitted VERBATIM by canvas-render's backend, so it must be safe
 * against untrusted document text. MathJax typesets TeX into its own glyph
 * paths (source text never passes through unescaped), and mermaid runs at
 * `securityLevel: 'strict'`, which sanitizes labels and disables script-
 * bearing constructs.
 */
import type { RenderedSvgFragment } from '@kamiazya/whiteboard-canvas-render'
import { getAppLogger } from './app-logger.js'
import type { FragmentLoaders } from './fragment-requests.js'

const log = getAppLogger('markdown-fragments')

/**
 * MathJax reports dimensions in ex units; canvas-render's scene works in
 * CSS px. 1ex of the default MathJax font at the preview's 16px body size
 * measures ≈8px — close enough for block sizing, where the fragment scales
 * into whatever bbox it is given.
 */
const MATHJAX_EX_TO_PX = 8

type MathJaxConvert = (value: string) => string

let mathjaxSingleton: Promise<MathJaxConvert | undefined> | undefined

async function loadMathJax(): Promise<MathJaxConvert | undefined> {
  try {
    const [
      { mathjax },
      { TeX },
      { SVG },
      { liteAdaptor },
      { RegisterHTMLHandler },
      { AllPackages },
    ] = await Promise.all([
      import('mathjax-full/js/mathjax.js'),
      import('mathjax-full/js/input/tex.js'),
      import('mathjax-full/js/output/svg.js'),
      import('mathjax-full/js/adaptors/liteAdaptor.js'),
      import('mathjax-full/js/handlers/html.js'),
      import('mathjax-full/js/input/tex/AllPackages.js'),
    ])
    const adaptor = liteAdaptor()
    RegisterHTMLHandler(adaptor)
    // fontCache 'local' keeps each fragment self-contained: 'global' would
    // put shared glyph <defs> outside the fragment, which cannot survive
    // being embedded into the preview's larger SVG document.
    // `href` is excluded from the package set: \href{javascript:...}{x}
    // would put an attacker-controlled URL into SVG this app injects
    // verbatim (see fragmentHrefsAreLocal for the output-side guard).
    const tex = new TeX({ packages: AllPackages.filter((name) => name !== 'href') })
    const svg = new SVG({ fontCache: 'local' })
    const doc = mathjax.document('', { InputJax: tex, OutputJax: svg })
    return (value: string) => {
      const node = doc.convert(value, { display: true })
      // convert() returns an mjx-container element; the <svg> child is the
      // fragment canvas-render embeds.
      return adaptor.innerHTML(node)
    }
  } catch (err) {
    log.warn('MathJax failed to load; math keeps the source placeholder', { err })
    return undefined
  }
}

/**
 * Output-side guard for both engines (defense in depth behind the
 * per-engine config): a fragment is embedded verbatim, so every
 * (xlink:)href it carries must be a fragment-local `#...` reference —
 * MathJax's glyph <use> reuse and mermaid's marker refs are exactly that.
 * Any other target (javascript:, data:, https:, or an obfuscated
 * java\nscript:) rejects the whole fragment; the layout keeps its
 * documented fallback rather than rendering a link this code cannot vouch
 * for.
 */
function fragmentHrefsAreLocal(svg: string): boolean {
  const hrefPattern = /(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
  for (const match of svg.matchAll(hrefPattern)) {
    const target = (match[1] ?? match[2] ?? '').trim()
    if (!target.startsWith('#')) return false
  }
  return true
}

const SCRIPT_ELEMENT = /<script\b/i
const WHITESPACE = /\s/
const TAG_NAME_END = /[\s/>]/
const ATTR_NAME_END = /[\s=>/]/
const UNQUOTED_VALUE_END = /[\s>]/
const HANDLER_FOUND = -1

/** The first index at or after `from` whose character `stop` matches. */
function scanUntil(svg: string, from: number, stop: RegExp): number {
  let i = from
  while (i < svg.length && !stop.test(svg.charAt(i))) i++
  return i
}

function skipWhitespace(svg: string, from: number): number {
  let i = from
  while (i < svg.length && WHITESPACE.test(svg.charAt(i))) i++
  return i
}

/** The index just past the attribute value starting at `from`. */
function skipAttributeValue(svg: string, from: number): number {
  const quote = svg.charAt(from)
  if (quote !== '"' && quote !== "'") return scanUntil(svg, from, UNQUOTED_VALUE_END)
  const close = svg.indexOf(quote, from + 1)
  return close < 0 ? svg.length : close + 1
}

/**
 * Walks the attributes of the tag starting at `from`: `HANDLER_FOUND` when
 * one is an `on<event>=`, otherwise the index where the tag ends, so the
 * caller resumes there and the whole walk stays linear.
 */
function scanTagForEventHandler(svg: string, from: number): number {
  let i = from
  while (i < svg.length && svg.charAt(i) !== '>') {
    const nameStart = i
    i = scanUntil(svg, i, ATTR_NAME_END)
    if (i === nameStart) {
      i++
      continue
    }
    const afterName = skipWhitespace(svg, i)
    if (svg.charAt(afterName) !== '=') {
      i = afterName
      continue
    }
    if (/^on/i.test(svg.slice(nameStart, i))) return HANDLER_FOUND
    i = skipAttributeValue(svg, skipWhitespace(svg, afterName + 1))
  }
  return i
}

/**
 * Whether any tag carries an `on<event>=` attribute. A linear walk rather
 * than one regex: a pattern that follows quoted values (so a `>` inside an
 * earlier value does not end the tag) backtracks catastrophically, and one
 * that does not is bypassed by that `>`. Only tags are read, so label TEXT
 * that happens to say `onclick=` does not refuse a diagram.
 */
function hasEventHandlerAttribute(svg: string): boolean {
  for (let open = svg.indexOf('<'); open >= 0; open = svg.indexOf('<', open + 1)) {
    if (!/[a-zA-Z]/.test(svg.charAt(open + 1))) continue
    const end = scanTagForEventHandler(svg, scanUntil(svg, open + 1, TAG_NAME_END))
    if (end === HANDLER_FOUND) return true
    open = end
  }
  return false
}

/**
 * Whether an engine's SVG may be embedded verbatim: every reference is
 * local, and nothing in it runs script. `<foreignObject>` is deliberately
 * not refused — mermaid draws most diagram kinds' labels through it.
 */
export function fragmentIsEmbeddable(svg: string): boolean {
  return fragmentHrefsAreLocal(svg) && !SCRIPT_ELEMENT.test(svg) && !hasEventHandlerAttribute(svg)
}

/** Parses `width="12.5ex"`-style MathJax root attributes into px. */
function exAttrToPx(svg: string, attr: 'width' | 'height'): number | undefined {
  const match = svg.match(new RegExp(`${attr}="([0-9.]+)ex"`))
  const ex = match?.[1] !== undefined ? Number(match[1]) : Number.NaN
  return Number.isFinite(ex) ? ex * MATHJAX_EX_TO_PX : undefined
}

/** Typesets one display-math block; inline math is drawn as source by the layout. */
async function renderMathFragment(value: string): Promise<RenderedSvgFragment | undefined> {
  mathjaxSingleton ??= loadMathJax()
  const convert = await mathjaxSingleton
  if (convert === undefined) return undefined
  try {
    const svg = convert(value)
    if (!svg.startsWith('<svg') || !fragmentIsEmbeddable(svg)) return undefined
    const width = exAttrToPx(svg, 'width')
    const height = exAttrToPx(svg, 'height')
    return {
      svg,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    }
  } catch (err) {
    log.warn('math typesetting failed; keeping the source placeholder', { value, err })
    return undefined
  }
}

type MermaidApi = {
  render: (id: string, text: string) => Promise<{ svg: string }>
}

let mermaidSingleton: Promise<MermaidApi | undefined> | undefined
let mermaidRenderSeq = 0

async function loadMermaid(): Promise<MermaidApi | undefined> {
  try {
    const mermaid = (await import('mermaid')).default
    mermaid.initialize({
      startOnLoad: false,
      // 'strict' sanitizes labels and blocks script-bearing constructs —
      // load-bearing for the PreviewPane verbatim-injection rationale.
      securityLevel: 'strict',
      // Keys a diagram's own `%%{init}%%` directive may not override. Setting
      // `secure` replaces mermaid's list, so its defaults are repeated here;
      // `themeCSS` would otherwise let document text inject CSS into a
      // fragment embedded verbatim, and `dompurifyConfig` loosen the label
      // sanitiser that 'strict' relies on.
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'suppressErrorRendering',
        'maxEdges',
        'dompurifyConfig',
        'themeCSS',
      ],
      theme: 'neutral',
      // Pure-SVG labels: foreignObject/HTML labels would not survive the
      // trip through canvas-render's SVG document (and would break any
      // future rasterized export of the same scene).
      flowchart: { htmlLabels: false },
    })
    return mermaid
  } catch (err) {
    log.warn('mermaid failed to load; fences keep the plain code block', { err })
    return undefined
  }
}

/**
 * Parses a numeric (px) attribute, or the viewBox fallback, from the ROOT
 * `<svg …>` opening tag only — matching anywhere in the document would pick
 * up the first inner element's width (a mermaid node rect, say) and report
 * a fragment size far smaller than the diagram, which then letterboxes the
 * whole render down to it.
 */
function svgDimension(svg: string, attr: 'width' | 'height'): number | undefined {
  const rootTag = svg.slice(0, svg.indexOf('>') + 1)
  const direct = rootTag.match(new RegExp(`${attr}="([0-9.]+)"`))
  const value = direct?.[1] !== undefined ? Number(direct[1]) : Number.NaN
  if (Number.isFinite(value)) return value
  const viewBox = rootTag.match(/viewBox="[0-9.-]+ [0-9.-]+ ([0-9.]+) ([0-9.]+)"/)
  const fromBox = attr === 'width' ? viewBox?.[1] : viewBox?.[2]
  const parsed = fromBox !== undefined ? Number(fromBox) : Number.NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

async function renderDiagramFragment(
  lang: string,
  value: string,
): Promise<RenderedSvgFragment | undefined> {
  if (lang !== 'mermaid') return undefined
  mermaidSingleton ??= loadMermaid()
  const mermaid = await mermaidSingleton
  if (mermaid === undefined) return undefined
  try {
    const { svg } = await mermaid.render(`wb-mermaid-${mermaidRenderSeq++}`, value)
    if (!fragmentIsEmbeddable(svg)) return undefined
    const width = svgDimension(svg, 'width')
    const height = svgDimension(svg, 'height')
    return {
      svg,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    }
  } catch (err) {
    log.warn('mermaid rendering failed; keeping the plain code block', { err })
    return undefined
  }
}

/** Both engines, as every surface that typesets is handed them. */
export const FRAGMENT_ENGINES: FragmentLoaders = {
  math: renderMathFragment,
  diagram: renderDiagramFragment,
}
