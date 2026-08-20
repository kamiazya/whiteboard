/**
 * The SVG backend's intermediate representation: plain data between the
 * scene-graph renderers and the canonical serializer. Renderers describe
 * WHAT to emit as a tree of `SvgVNode`s; `serialize.ts` is the only code
 * that turns that tree into bytes, so escaping, number formatting and
 * attribute ordering cannot diverge per call site.
 */

import type { SvgElements, SvgTagName } from './elements.js'

/**
 * `undefined` means the attribute is omitted — the presence-only rule
 * (an absent field is never defaulted) expressed as a type. Numbers are
 * formatted by the serializer through `formatCoord`, strings through
 * `escapeXmlAttr`; a call site never pre-formats either.
 */
export type SvgAttrValue = string | number | undefined

export type SvgAttrs = Readonly<Record<string, SvgAttrValue>>

/**
 * A child emitted verbatim, bypassing text escaping. The only legitimate
 * producers are trusted, already-well-formed fragments (the `svgFragment`
 * scene node's payload, whose well-formedness is the CALLER's documented
 * precondition). A runtime wrapper rather than a branded string because
 * the serializer must distinguish it from escapable text at runtime.
 */
export interface RawXmlChild {
  readonly raw: string
}

export function rawXml(xml: string): RawXmlChild {
  return { raw: xml }
}

/**
 * Nested arrays are flattened in document order, so a renderer that
 * produces a fragment (several siblings, possibly none) composes without
 * wrapper elements — the empty array is the VNode spelling of the string
 * backend's `''` degradation.
 */
export type SvgChild = SvgVNode | string | RawXmlChild | ReadonlyArray<SvgChild>

export interface SvgVNode {
  readonly tag: string
  readonly attrs?: SvgAttrs
  /**
   * Absent children self-close the element (`<g/>`); a present-but-empty
   * array keeps the paired form (`<g></g>`). The distinction is
   * load-bearing for byte-identical output, not cosmetic.
   */
  readonly children?: ReadonlyArray<SvgChild>
  /**
   * Shared definitions this element depends on (`<mask>`, `<linearGradient>`,
   * …). Declared where the dependency arises; `collectDefs` (defs.ts) hoists
   * them into the document's single `<defs>` element, deduplicated by `id` —
   * so a definition is emitted only when something in the tree actually
   * references it (presence-only, mechanized). Ids must be derived from the
   * definition's CONTENT (never a counter or randomness): same id ⇒ same
   * bytes is what makes a repeated id across several inline-injected SVGs
   * harmless, and what keeps first-occurrence-wins deduplication sound.
   */
  readonly defs?: ReadonlyArray<SvgDef>
}

export interface SvgDef {
  readonly id: string
  readonly node: SvgVNode
}

export function withDefs(node: SvgVNode, defs: ReadonlyArray<SvgDef>): SvgVNode {
  return { ...node, defs }
}

/**
 * Builds one element VNode. The public signature is constrained by the
 * typed element table (elements.ts): only emitted element names, only
 * their declared attributes, numbers where `formatCoord` is the contract.
 * The VNode itself stores attrs loosely — the table is a construction-time
 * gate, not a runtime shape.
 */
export function el<T extends SvgTagName>(
  tag: T,
  attrs?: SvgElements[T],
  children?: ReadonlyArray<SvgChild>,
): SvgVNode
export function el(tag: string, attrs?: SvgAttrs, children?: ReadonlyArray<SvgChild>): SvgVNode {
  return {
    tag,
    ...(attrs === undefined ? {} : { attrs }),
    ...(children === undefined ? {} : { children }),
  }
}
