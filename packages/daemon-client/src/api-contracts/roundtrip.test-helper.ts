/**
 * Parse a value through the JSON wire format (stringify → parse → schema.parse)
 * so api-contract tests can assert that no fields drift across serialization.
 */
export function roundtrip<T>(schema: { parse: (v: unknown) => T }, value: T): T {
  return schema.parse(JSON.parse(JSON.stringify(value)))
}
