import { z } from 'zod'

/**
 * `z.number().int()` with the safe-integer bounds kept OUT of the JSON
 * Schema a model reads. Zod emits `minimum: -9007199254740991, maximum:
 * 9007199254740991` on every `.int()` field, and a spatial canvas has forty
 * integer fields in one tool's input — 1,620 bytes of bounds that tell a
 * model nothing it can act on, on every turn. Validation is `.int()`'s
 * exactly (`multipleOf(1)` was tried and accepts a denormal like 1.4e-45);
 * only the emitted schema changes, to `{ "type": "integer" }`.
 *
 * Two forms rather than a chained `.nonnegative()`, because `.meta()`
 * overrides are applied over the generated schema and a `minimum:
 * undefined` would erase the `minimum: 0` the check emits.
 */
export const integerSchema = z.number().int().meta({ minimum: undefined, maximum: undefined })
export const nonnegativeIntegerSchema = z.number().int().nonnegative().meta({ maximum: undefined })
