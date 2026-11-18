import { createElement, type HTMLAttributes, type Ref } from 'react'

interface SceneSvgProps
  extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'dangerouslySetInnerHTML'> {
  /** A trusted serializer's SVG (the core's, or canvas-render's for a refused layout's notice), or a root-size derivation of it, below — never any other string. */
  readonly svg: string
  /** The host element; `figure` for a region that names its content, `span` inside a line. */
  readonly as?: 'div' | 'figure' | 'span'
  readonly ref?: Ref<HTMLElement>
}

/**
 * The one place a scene's SVG string becomes DOM.
 *
 * Injecting it as markup is sound BECAUSE the string has one producer, a
 * serializer this repo owns: the core's
 * (crates/core/canvas-render/src/svg/serialize.rs, over `xml_escape.rs`), which
 * draws every picture, a refused layout's notice included. It escapes
 * `&`/`<`/`>` in text content plus `"`/`'` in attribute values, so document
 * text and attributes have no untrusted-HTML path; this is not a sink that
 * needs a sanitizer, and none must be added.
 *
 * One part is NOT escaped: an `svgFragment` (a formula or a diagram) is
 * emitted verbatim by the serializer, after a well-formedness check. That
 * check is not what makes it safe — it is trusted because the HOST's own
 * renderer (MathJax, mermaid) produced it from the source, never because a
 * document supplied SVG. A host that fed a fragment table from anywhere else
 * would void this argument.
 *
 * Two derivations keep the rest true and
 * are the only ones allowed — the keyed projection's group strings, which
 * are the same serializer's bytes, and the two that touch only the root
 * tag's size: `fitSvgToBox`, which drops its `width`/`height`/
 * `preserveAspectRatio`, and `CanvasViewer`'s `fillingItsHost`, which sets its
 * `width`/`height` to `100%`. If a
 * caller's string comes from anywhere else this reasoning no longer holds
 * and the caller must not use this component.
 *
 * `tools/arch-lint`'s `html-sink-ledger.test.ts` pins every markup sink in
 * the source against a classified ledger, so a second spelling of this
 * argument fails until someone says why it is different.
 */
export function SceneSvg({ svg, as = 'div', ...host }: SceneSvgProps) {
  return createElement(as, {
    ...host,
    // `createElement` rather than JSX so one `ref` type serves all three tags;
    // Biome's noDangerouslySetInnerHtml does not read this form, which is why
    // the sink ledger in tools/arch-lint is what holds the argument above.
    dangerouslySetInnerHTML: { __html: svg },
  })
}
