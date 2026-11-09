import type { z } from 'zod'
import { EXTENSION_FACET_KEY_PATTERN, RESERVED_ROOT_KEYS } from './facet-keys.js'

// The named checks of `contracts/model`'s `x-wb-check` keyword, in the
// camelCase the generated Zod imports. Each is a `superRefine` callback so a
// check can report several issues at paths of its own, and each has a Rust
// twin of the snake_case name in `whiteboard-model`'s `checks.rs`; the pair is
// held equal by the differential, not by this file.
//
// This module never imports the generated schemas, which is what lets them
// import it without a cycle.

/** OKF section 7's actor: a non-blank, single-line string with no surrounding whitespace. */
export function okfActor(value: string, ctx: z.core.$RefinementCtx<string>): void {
  if (value.trim() !== value || /[\r\n]/.test(value)) {
    ctx.addIssue({
      code: 'custom',
      message: 'an OKF actor is a single-line string with no surrounding whitespace',
    })
  }
}

/**
 * A malformed key is an issue rather than a silent drop, so a bad key fails the
 * whole parse instead of losing data.
 */
export function extensionFacetKeys(
  value: Record<string, unknown>,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  for (const key of Object.keys(value)) {
    if (!EXTENSION_FACET_KEY_PATTERN.test(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `extension facet key "${key}" must match {namespace}.{name}/v{n}, e.g. "visual.shape/v0"`,
        path: [key],
      })
    }
  }
}

/** A reserved root key lives in its own bucket, never in `facetsRaw` too. */
export function facetsRawKeys(
  value: Record<string, unknown>,
  ctx: z.core.$RefinementCtx<Record<string, unknown>>,
): void {
  for (const key of Object.keys(value)) {
    if ((RESERVED_ROOT_KEYS as readonly string[]).includes(key)) {
      ctx.addIssue({
        code: 'custom',
        message: `"${key}" is a reserved root key and cannot appear in facetsRaw`,
        path: [key],
      })
    }
  }
}
