import { canvasColorSchema } from '@kamiazya/whiteboard-model'
import type { z } from 'zod'

// The named checks of `contracts/facets/visual`'s `x-wb-check` keyword, in the
// camelCase the generated Zod imports; each has a Rust twin of the snake_case
// name in `whiteboard-plugin-visual`'s `checks.rs`.
//
// This module never imports the generated schemas, which is what lets them
// import it without a cycle.

// An explicit locale, never the host's default: the same text must split the
// same way on every machine (QR-20b).
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' })

/**
 * ONE grapheme cluster, which is what "a badge" means. A cluster may be many
 * code points (a variation selector, a ZWJ family, a flag pair), which is why
 * this counts graphemes rather than length. Deliberately NOT emoji-only: the
 * scene node a symbol draws through names a CJK character or a dingbat as
 * intended badge content, and a facet must not be narrower than the substrate
 * that renders it.
 */
export function singleGrapheme(value: string, ctx: z.core.$RefinementCtx<string>): void {
  if ([...graphemes.segment(value)].length !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be a single character or emoji, not a string',
    })
  }
}

/**
 * A colour the model's canvas colour accepts, worded for the author of a
 * stencil rather than as the model's own union refusal, which names a hex
 * colour only and hides the presets they most likely meant.
 */
export function canvasColor(value: string, ctx: z.core.$RefinementCtx<string>): void {
  if (!canvasColorSchema.safeParse(value).success) {
    ctx.addIssue({
      code: 'custom',
      message: 'must be a preset "1" to "6" or a 6-digit hex color like "#ff0000"',
    })
  }
}
