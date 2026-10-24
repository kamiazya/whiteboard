import type { z } from 'zod'

/** The key a UTF-16 length refusal carries in its issue's `params`. */
export const UTF16_MAX_PARAM = 'utf16Max'

/**
 * `schema` limited to `max` UTF-16 code units — what `String#length`, the
 * Loro and SQLite stores and every editor's counter agree on.
 *
 * Zod's own `.max()` counts Unicode code points since 4.6, so `'😀'` costs
 * one there and two here; a limit written as `.max(n)` alone would admit
 * twice the text its constant names. The `.max()` stays so the emitted JSON
 * Schema keeps its `maxLength` (a model reads it, and it is the looser,
 * still-true bound), and the refinement tightens it to the unit the limit is
 * stated in. A refinement and never a transform: a transform anywhere under a
 * published schema cannot be emitted as JSON Schema and empties `tools/list`.
 *
 * The refinement stands down when `.max()` already refused the value, so an
 * overlong string is reported once, and when the value is not a string at all.
 */
export function utf16Max<T extends z.ZodString | z.ZodURL>(
  schema: T,
  max: number,
  message?: string,
): T {
  // `max` and `refine` return `this`, so the chain keeps the caller's schema type;
  // the two arms' overloads just cannot be called through their union.
  const bounded = (schema as z.ZodString).max(max, message)
  return bounded.refine((value) => value.length <= max, {
    error: message ?? `Too big: expected string to have <=${max} UTF-16 units`,
    params: { [UTF16_MAX_PARAM]: max },
    // A supplied `when` replaces zod's own skip-after-abort, so a value that was never a string
    // (a missing key) has to be excluded here too.
    when: (payload) =>
      typeof payload.value === 'string' &&
      !payload.issues.some((issue) => issue.code === 'too_big'),
  }) as unknown as T
}
