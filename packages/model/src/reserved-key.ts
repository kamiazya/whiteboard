/**
 * The one key no stored value may hold. `JSON.parse` and the YAML parser
 * DEFINE a `__proto__` key as an own property, a Loro map stores it as one,
 * and every JSON projection of the record (`toJSON()`, a map's `get`) then
 * ASSIGNS it — which replaces the object's prototype instead of adding a key,
 * so a reader's `key in obj` answers for keys nobody wrote.
 */
export const RESERVED_MAP_KEY = '__proto__'

/**
 * Whether `object`'s prototype is one a `__proto__` assignment put there: an
 * object, but neither `Object.prototype` nor a class's own prototype. A class
 * instance (a Set, bytes, a Date) is some other refusal's business, and a
 * class prototype is told apart by a constructor FUNCTION pointing back at it
 * — which no JSON or YAML value can spell.
 */
function holdsAssignedPrototype(object: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(object)
  if (prototype === Object.prototype || prototype === null || typeof prototype !== 'object') {
    return false
  }
  const maker: unknown = Object.hasOwn(prototype, 'constructor')
    ? (prototype as { constructor: unknown }).constructor
    : undefined
  return !(typeof maker === 'function' && maker.prototype === prototype)
}

/**
 * Whether `value` holds, at any depth, the reserved key — in either of the
 * two forms it takes: an own `__proto__` property (what a parser hands a
 * writer) or an object whose prototype an assignment replaced (what a projection hands a
 * reader, since the key itself never survives into it).
 *
 * The one definition every writer and the sync judge ask, so what a write
 * may store and what a sync update may carry cannot disagree.
 */
export function holdsReservedKey(value: unknown): boolean {
  const pending: unknown[] = [value]
  // Each object is asked once, so a cyclic value ends rather than looping.
  const seen = new Set<object>()
  while (pending.length > 0) {
    const next = pending.pop()
    if (typeof next !== 'object' || next === null || seen.has(next)) continue
    seen.add(next)
    // Pushed one at a time: a spread passes each element as an argument, and
    // a value wide enough throws RangeError before it is judged.
    if (Array.isArray(next)) {
      for (const item of next) pending.push(item)
      continue
    }
    if (Object.hasOwn(next, RESERVED_MAP_KEY)) return true
    if (holdsAssignedPrototype(next)) return true
    for (const item of Object.values(next)) pending.push(item)
  }
  return false
}
