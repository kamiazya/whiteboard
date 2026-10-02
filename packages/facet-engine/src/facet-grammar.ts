/**
 * The facet key grammar, spelled once for everything at or above the engine
 * (ADR-0013 decision 2): a key is `{namespace}.{name}/v{n}`, each of the two
 * halves a lowercase segment.
 *
 * `model` keeps its own copy of the same expression (the two packages are
 * both "zod only" and cannot import each other); `facet-grammar.test.ts`
 * compares them, and `tools/arch-lint`'s `facet-grammar-one-place.test.ts`
 * bans a third spelling. A schema that wants its own refusal message imports
 * the pattern and writes the message, not the expression.
 */

/** One half of a key, and an asset's bare name. */
export const FACET_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/** A facet key without capture groups, so its `source` equals model's. */
export const FACET_KEY_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\/v[0-9]+$/

/** `<plugin>.<name>`: the id of a registered silhouette, theme or icon. */
export const FACET_NAMESPACED_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/
