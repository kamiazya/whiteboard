/**
 * Everything `toStrictEqual` would look at, spelled out: that matcher compares
 * a `constructor` property by identity, so it calls two equal documents
 * different when a facet is named `constructor`.
 */
export function shapeOf(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  const proto = Object.getPrototypeOf(value)
  return {
    proto:
      proto === null
        ? 'null'
        : proto === Object.prototype
          ? 'Object'
          : proto === Array.prototype
            ? 'Array'
            : 'other',
    keys: Reflect.ownKeys(value),
    values: Reflect.ownKeys(value).map((key) =>
      shapeOf((value as Record<PropertyKey, unknown>)[key]),
    ),
  }
}
