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
 * `securityLevel: 'strict'` with HTML labels locked off, so a label is SVG
 * text rather than markup. `fragmentIsEmbeddable` re-checks the output of
 * both engines.
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

/**
 * TeX packages that let document text choose markup or CSS in SVG this app
 * injects into its own DOM: `html` (`\\href`, `\\class`, `\\cssId`,
 * `\\style` — an id can clobber a global, a class borrow the app's CSS),
 * `bbox` (any `name: value` in its option becomes an inline style) and
 * `unicode` (its optional font argument becomes a `font-family` style, cached
 * per code point across documents). `require` and `autoload` load packages at
 * typeset time, `html` included under their default allow lists, and
 * `setoptions` lets document text change TeX options; none is in
 * `AllPackages` today, and naming them keeps it that way across an upgrade.
 * `fragmentIsEmbeddable` is the output-side guard for URLs alone.
 */
const REFUSED_TEX_PACKAGES = new Set([
  'html',
  'bbox',
  'unicode',
  'require',
  'autoload',
  'setoptions',
])

/**
 * What the base package's `\\mmlToken{kind}[attrs]{text}` may not write.
 * Its allow list admits these beside a token's own MathML attributes, and
 * the SVG output writes them out — the html package's `\\cssId`, `\\class`,
 * `\\style` and `\\href`, and `\\unicode`'s font, by another door, reachable
 * through any macro that expands to it.
 */
const AUTHOR_MARKUP_ATTRIBUTES = ['id', 'class', 'style', 'href', 'fontfamily']

/**
 * MathJax's own marker for the attributes `\\mmlToken` copied from document
 * text, read and removed by its `cleanAttributes` post-filter — so this one
 * runs before it and drops the refused ones from exactly those nodes, leaving
 * what MathJax sets itself (an `\\eqref`'s local link and class) alone.
 */
const AUTHOR_ATTRIBUTES_MARKER = 'mjx-keep-attrs'

type TexAttributes = {
  get(name: string): unknown
  getAllAttributes(): Record<string, unknown>
}
type TexPostFilterArgument = {
  data: { root: { walkTree(visit: (node: { attributes?: TexAttributes }) => void): void } }
}

function dropAuthorMarkup({ data }: TexPostFilterArgument): void {
  data.root.walkTree((node) => {
    const attributes = node.attributes
    const named = attributes?.get(AUTHOR_ATTRIBUTES_MARKER)
    if (attributes === undefined || typeof named !== 'string') return
    const authored = new Set(named.split(' '))
    const all = attributes.getAllAttributes()
    for (const name of AUTHOR_MARKUP_ATTRIBUTES) {
      if (authored.has(name)) delete all[name]
    }
  })
}

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
    const tex = new TeX({ packages: AllPackages.filter((name) => !REFUSED_TEX_PACKAGES.has(name)) })
    // Ahead of MathJax's own `cleanAttributes` (priority -2), which consumes
    // the marker this reads.
    tex.postFilters.add(dropAuthorMarkup, -10)
    // fontCache 'local' keeps each fragment self-contained: 'global' would
    // put shared glyph <defs> outside the fragment, which cannot survive
    // being embedded into the preview's larger SVG document.
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

// Each element pattern admits a namespace prefix: an exported SVG opened on
// its own is parsed as XML, where `<s:script>` under a prefix bound to the
// SVG namespace is the same element as `<script>`. The prefix is any run of
// name characters, not ASCII word characters: an XML name may start with any
// letter, so `<é:script>` is a script element too.
/** A namespace prefix, as the element patterns here admit one. */
const ELEMENT_PREFIX = String.raw`[^\s<>/:="']+:`
const SCRIPT_ELEMENT = /<(?:[^\s<>/:="']+:)?script\b/i
/**
 * Live HTML inside an SVG: a `<foreignObject>` carries arbitrary XHTML (a
 * form, a button) that works in the app-origin preview and in an exported
 * SVG opened on its own.
 */
const HTML_ISLAND_ELEMENT = /<(?:[^\s<>/:="']+:)?(?:foreignObject|form)\b/i
/**
 * Markup the HTML parser reads differently from XML. The fragment reaches the
 * DOM through `innerHTML`, where a breakout tag (HTML's foreign-content list,
 * `font` included, and the `</p>`/`</br>` end tags) leaves SVG for HTML. Past
 * it, a raw-text or RCDATA element reads its body as text to its own close, so
 * `<textarea><x y="</textarea><img onerror>">` — one quoted attribute to
 * every other check here — ends in a live `<img>`. The raw-text names are
 * refused too, so a gap in the breakout list is not enough on its own; `style`
 * and `title` are not, being SVG elements both engines write, and
 * `hasMarkupInIntegrationPoint` covers them. Neither engine writes any of these.
 */
const HTML_PARSER_ELEMENT = new RegExp(
  String.raw`<(?:${ELEMENT_PREFIX})?(?:${[
    'b',
    'big',
    'blockquote',
    'body',
    'br',
    'center',
    'code',
    'dd',
    'div',
    'dl',
    'dt',
    'em',
    'embed',
    'font',
    'h[1-6]',
    'head',
    'hr',
    'i',
    'img',
    'li',
    'listing',
    'menu',
    'meta',
    'nobr',
    'ol',
    'p',
    'pre',
    'ruby',
    's',
    'small',
    'span',
    'strong',
    'strike',
    'sub',
    'sup',
    'table',
    'tt',
    'u',
    'ul',
    'var',
    'textarea',
    'xmp',
    'iframe',
    'noembed',
    'noframes',
    'noscript',
    'plaintext',
  ].join('|')})(?![^\s/>])|<\/(?:${ELEMENT_PREFIX})?(?:p|br)(?![^\s/>])`,
  'i',
)
/**
 * A comment, CDATA section or doctype, and the tokenizer's two other
 * bogus-comment openers: `<?`, and `</` before anything but an ASCII letter
 * or `>` (an empty `</>` is dropped, not a comment). Every check here reads
 * `<!--<g a="-->` as the start of a quoted attribute while the HTML parser
 * closes the comment at `-->` — a bogus one at the first `>` — so whatever
 * follows is live markup the attribute walk never read.
 */
const MARKUP_DECLARATION = /<[!?]|<\/(?![a-zA-Z>])/
/**
 * SVG's `title` and `desc` are HTML integration points: what they hold is
 * parsed as HTML, where `<style>` is raw text to its close. Mermaid writes a
 * `<title>`, always holding text alone, so one that holds an element was
 * steered there by document text.
 */
const INTEGRATION_POINT_OPEN = new RegExp(
  String.raw`<(?:${ELEMENT_PREFIX})?(title|desc)(?![^\s/>])`,
  'gi',
)

/**
 * Whether a `title` or `desc` holds an element. Each open tag's end is found
 * by the attribute walk `hasRefusedAttribute` uses, which reads a quote as
 * opening a value only right after `=`, as the HTML tokenizer does — so
 * `<title x=a'>` ends at its `>`. A tag that never ends, or carries a refused
 * attribute, refuses the fragment: answering "no markup" there would skip
 * every integration point after it.
 */
function hasMarkupInIntegrationPoint(svg: string): boolean {
  const opens = new RegExp(INTEGRATION_POINT_OPEN.source, 'gi')
  for (let open = opens.exec(svg); open; open = opens.exec(svg)) {
    const bodyStart = scanTagForRefusedAttribute(svg, scanUntil(svg, open.index + 1, TAG_NAME_END))
    if (bodyStart === HANDLER_FOUND || bodyStart >= svg.length) return true
    const close = new RegExp(String.raw`</(?:${ELEMENT_PREFIX})?${open[1]}(?![^\s/>])`, 'gi')
    close.lastIndex = bodyStart
    const end = close.exec(svg)?.index ?? svg.length
    if (/<[a-zA-Z]/.test(svg.slice(bodyStart, end))) return true
    opens.lastIndex = Math.max(end, bodyStart)
  }
  return false
}
/**
 * SMIL animation rewrites an attribute after every check here has read it —
 * `<set attributeName="href" to="javascript:…">` turns a local link into a
 * script one in an exported SVG, which has no CSP. Neither engine animates.
 */
const ANIMATION_ELEMENT =
  /<(?:[^\s<>/:="']+:)?(?:animate|animateMotion|animateTransform|animateColor|set)[\s/>]/i
/**
 * Any `url(` whose target is not a fragment-local `#id` (CSS or attribute),
 * and any `image-set(` (`-webkit-` included), which loads from a quoted
 * string without spelling `url(` at all. Neither engine writes one.
 */
const NON_LOCAL_URL = /url\((?!\s*(?:['"]\s*)?#)|image-set\(/i
/**
 * CSS that `NON_LOCAL_URL` cannot read: an escape (`u\72l(` is `url(`),
 * `@import`, which loads a sheet without spelling `url(` at all, and any
 * character reference but XML's five predefined ones — the parser decodes
 * `&#117;rl(`, `&#64;import` or HTML's named `&bsol;` before CSS reads the
 * text, in an attribute value and in SVG `<style>` text alike. Neither engine
 * writes an escape or a reference other than those five into CSS — a style
 * or presentation attribute, or a `<style>` element — or an `@import` anywhere.
 */
const UNREADABLE_CSS = /\\|@import|&(?!(?:amp|lt|gt|quot|apos);)/i
const STYLE_ELEMENT_OPEN = /<(?:[^\s<>/:="']+:)?style\b/gi
const STYLE_ELEMENT_CLOSE = /<\/(?:[^\s<>/:="']+:)?style\b/i
const FORM_ATTRIBUTE = /^(?:form)?action$/i
/** A frame's inline document and an `<object>`'s resource. */
const EMBEDDING_ATTRIBUTE = /^(?:[^\s<>/:="']+:)?(?:srcdoc|data)$/i
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

/** The attribute value spanning `[from, end)`, without its quotes. */
function attributeValue(svg: string, from: number, end: number): string {
  const quote = svg.charAt(from)
  const quoted = quote === '"' || quote === "'"
  return svg.slice(quoted ? from + 1 : from, quoted ? end - 1 : end).trim()
}

/**
 * Attributes whose value CSS reads: `style`, and the presentation attributes
 * that take a `url()` — SVG2 parses those with the CSS value grammar, so an
 * escape or character reference in one reaches a `url(` that `NON_LOCAL_URL`,
 * reading the raw text, never sees.
 */
const CSS_VALUED_ATTRIBUTE =
  /^(?:style|fill|stroke|filter|mask|clip-path|marker|marker-start|marker-mid|marker-end|cursor)$/i

/** `src`, and `href` under any prefix — XML binds `x:href` to xlink as readily as `xlink:href`. */
const LINK_ATTRIBUTE = /^(?:src|(?:[^\s<>/:="']+:)?href)$/i

/**
 * An attribute that runs script (`on<event>`), submits a form
 * (`action`/`formaction`), holds CSS `NON_LOCAL_URL` cannot read, or loads from outside the fragment (a `src` or
 * `href` not naming a local `#id`, quoted or not — `fragmentHrefsAreLocal`
 * reads quoted values only).
 */
function isRefusedAttribute(name: string, value: string): boolean {
  if (/^on/i.test(name) || FORM_ATTRIBUTE.test(name) || EMBEDDING_ATTRIBUTE.test(name)) return true
  if (CSS_VALUED_ATTRIBUTE.test(name) && UNREADABLE_CSS.test(value)) return true
  return LINK_ATTRIBUTE.test(name) && !value.startsWith('#')
}

/**
 * Walks the attributes of the tag starting at `from`: `HANDLER_FOUND` when
 * one is refused, otherwise the index where the tag ends, so the caller
 * resumes there and the whole walk stays linear.
 */
function scanTagForRefusedAttribute(svg: string, from: number): number {
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
    const name = svg.slice(nameStart, i)
    const valueStart = skipWhitespace(svg, afterName + 1)
    i = skipAttributeValue(svg, valueStart)
    if (isRefusedAttribute(name, attributeValue(svg, valueStart, i))) return HANDLER_FOUND
  }
  return i
}

/**
 * Whether any tag carries a refused attribute. A linear walk rather
 * than one regex: a pattern that follows quoted values (so a `>` inside an
 * earlier value does not end the tag) backtracks catastrophically, and one
 * that does not is bypassed by that `>`. Only tags are read, so label TEXT
 * that happens to say `onclick=` does not refuse a diagram.
 */
function hasRefusedAttribute(svg: string): boolean {
  for (let open = svg.indexOf('<'); open >= 0; open = svg.indexOf('<', open + 1)) {
    if (!/[a-zA-Z]/.test(svg.charAt(open + 1))) continue
    const end = scanTagForRefusedAttribute(svg, scanUntil(svg, open + 1, TAG_NAME_END))
    if (end === HANDLER_FOUND) return true
    open = end
  }
  return false
}

/**
 * Whether a `<style>` element's text holds CSS `NON_LOCAL_URL` cannot read.
 * An element runs from its open to the next close, or to the end when none
 * follows. Every open before that close shares its end, so its text is part
 * of the first one's: reading from the first and resuming after the close
 * reads each character once.
 */
function hasUnreadableStyleElement(svg: string): boolean {
  const opens = new RegExp(STYLE_ELEMENT_OPEN.source, 'gi')
  const closes = new RegExp(STYLE_ELEMENT_CLOSE.source, 'gi')
  for (let open = opens.exec(svg); open; open = opens.exec(svg)) {
    closes.lastIndex = open.index
    const close = closes.exec(svg)
    const end = close ? close.index : svg.length
    if (UNREADABLE_CSS.test(svg.slice(open.index, end))) return true
    if (!close) return false
    opens.lastIndex = end
  }
  return false
}

/**
 * Whether an engine's SVG may be embedded verbatim: every reference is
 * local, nothing in it runs script, submits a form or animates, and it holds
 * no HTML.
 * Refusing `<foreignObject>` costs nothing at the engines' configuration —
 * neither emits one — so a fragment that carries one was steered there by
 * document text.
 */
export function fragmentIsEmbeddable(svg: string): boolean {
  return (
    fragmentHrefsAreLocal(svg) &&
    !SCRIPT_ELEMENT.test(svg) &&
    !HTML_ISLAND_ELEMENT.test(svg) &&
    !ANIMATION_ELEMENT.test(svg) &&
    !HTML_PARSER_ELEMENT.test(svg) &&
    !MARKUP_DECLARATION.test(svg) &&
    !hasMarkupInIntegrationPoint(svg) &&
    !NON_LOCAL_URL.test(svg) &&
    !hasUnreadableStyleElement(svg) &&
    !hasRefusedAttribute(svg)
  )
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
      // sanitiser that 'strict' relies on. `fontFamily` is CSS too — mermaid
      // only balances its braces, so `x{} .a{…}` writes a rule — and a key
      // here is refused at any depth of the directive, `themeVariables`'
      // own `fontFamily` included. The rest of `themeVariables` stays a
      // directive's to set: mermaid admits only letters, digits, spaces and
      // `#%(),.;` in its values, and any `url(` they spell is refused by
      // `fragmentIsEmbeddable`.
      secure: [
        'secure',
        'securityLevel',
        'startOnLoad',
        'maxTextSize',
        'suppressErrorRendering',
        'maxEdges',
        'dompurifyConfig',
        'themeCSS',
        'fontFamily',
        'htmlLabels',
      ],
      theme: 'neutral',
      // Pure-SVG labels, locked against a directive by `secure` above: an
      // HTML label is live markup (a form, a button) in the preview and in an
      // exported SVG, and would not survive rasterising either. The
      // top-level key is the one every diagram kind reads; `flowchart.htmlLabels`
      // is deprecated and loses to it. A `$$…$$` label is therefore drawn as
      // its source, since katex's MathML needs an HTML label.
      htmlLabels: false,
      // A journey draws task text through a <foreignObject> by default; tspan
      // placement keeps it SVG. A directive can still ask for 'fo', and
      // fragmentIsEmbeddable then refuses the diagram.
      journey: { textPlacement: 'tspan' },
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
