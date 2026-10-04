import { createElement, type HTMLAttributes, type Ref } from 'react'

interface SceneSvgProps
  extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'dangerouslySetInnerHTML'> {
  /** canvas-render's serializer output (or `fitSvgToBox` of it) — never any other string. */
  readonly svg: string
  /** The host element; `figure` for a region that names its content, `span` inside a line. */
  readonly as?: 'div' | 'figure' | 'span'
  readonly ref?: Ref<HTMLElement>
}

/**
 * The one place a scene's SVG string becomes DOM.
 *
 * Injecting it as markup is sound BECAUSE canvas-render's serializer
 * (packages/canvas-render/src/svg/format.ts) is the SOLE producer of the
 * string and escapes `&`/`<`/`>` in text content plus `"`/`'` in attribute
 * values: there is no untrusted-HTML path, so this is not a sink that needs
 * a sanitizer, and none must be added. Two derivations keep that true and
 * are the only ones allowed — the keyed projection's group strings, which
 * are the same serializer's bytes, and `fitSvgToBox`, which only drops the
 * root tag's `width`/`height`/`preserveAspectRatio` attributes. If a
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
