// The value wire the OKF and JSON Canvas exports share (`okf_wire.rs`,
// `json_canvas_wire.rs`): `null`, a boolean and a string are themselves,
// `["f", hex]` is the 64 bits of a double, `["b", digits]` a `bigint`,
// `["s", item...]` a sequence and `["m", key, item, ...]` a mapping in the
// order the host enumerates it. The canvas wire is `compact`: a number that is
// a safe integer other than `-0` is its own JSON number, which a canvas holds
// by the hundreds; the OKF wire spells every number as bits. A compact wire
// also leaves out a key whose value is `undefined`, as `JSON.stringify`
// does: a canvas that crossed other formats holds optional fields set to
// `undefined`, and the writer is asked about the document it would write.

// ES2024's `String.prototype.isWellFormed`, typed here so a consumer that
// compiles this source needs no newer `lib`; every runtime that loads the
// artifact has it (Node 20, the evergreen browsers since 2023).
export const isWellFormed = (s: string): boolean =>
  (s as string & { isWellFormed(): boolean }).isWellFormed()

const bits = new DataView(new ArrayBuffer(8))

function numberOf(hex: unknown): number | undefined {
  if (typeof hex !== 'string' || !/^[0-9a-f]{16}$/.test(hex)) return undefined
  bits.setBigUint64(0, BigInt(`0x${hex}`))
  return bits.getFloat64(0)
}

/** The value a wire stands for (see `okf_wire.rs`), or undefined when it is none. */
export function decodeValue(wire: unknown, compact = false): unknown {
  if (wire === null || typeof wire === 'boolean' || typeof wire === 'string') return wire
  if (typeof wire === 'number') return compact && Number.isSafeInteger(wire) ? wire : undefined
  if (!Array.isArray(wire)) return undefined
  const [tag, ...rest] = wire as unknown[]
  if (tag === 'f') return numberOf(rest[0])
  if (tag === 'b') return typeof rest[0] === 'string' ? BigInt(rest[0]) : undefined
  if (tag === 's') return decodeItems(rest, compact)
  return tag === 'm' ? decodeMap(rest, compact) : undefined
}

function decodeItems(wires: unknown[], compact: boolean): unknown[] | undefined {
  const items = wires.map((wire) => decodeValue(wire, compact))
  return items.includes(undefined) ? undefined : items
}

function decodeMap(wires: unknown[], compact: boolean): object | undefined {
  if (wires.length % 2 !== 0) return undefined
  const entries: [string, unknown][] = []
  for (let i = 0; i < wires.length; i += 2) {
    const [key, item] = [wires[i], decodeValue(wires[i + 1], compact)]
    if (typeof key !== 'string' || item === undefined) return undefined
    entries.push([key, item])
  }
  return Object.fromEntries(entries)
}

/** Deeper than any value the writers take (`maxDepth`), and short of a stack overflow. */
const WIRE_DEPTH = 100

const hex = (n: number): string => {
  bits.setFloat64(0, n)
  return bits.getBigUint64(0).toString(16).padStart(16, '0')
}

/**
 * The wire of a value (see `okf_wire.rs`), or undefined when it is not one a
 * document holds: an `undefined`, a function, a symbol, a class instance, a
 * string with a lone surrogate, a cycle or a sparse list.
 */
export function wireOf(value: unknown, depth: number, compact = false): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return isWellFormed(value) ? value : undefined
  if (typeof value === 'number') {
    return compact && Number.isSafeInteger(value) && !Object.is(value, -0)
      ? value
      : ['f', hex(value)]
  }
  if (typeof value === 'bigint') return ['b', value.toString()]
  if (typeof value !== 'object' || depth > WIRE_DEPTH) return undefined
  return Array.isArray(value)
    ? wireOfList(value, depth, compact)
    : wireOfRecord(value, depth, compact)
}

function wireOfList(list: unknown[], depth: number, compact: boolean): unknown[] | undefined {
  const out: unknown[] = ['s']
  for (let i = 0; i < list.length; i++) {
    const item = i in list ? wireOf(list[i], depth + 1, compact) : undefined
    if (item === undefined) return undefined
    out.push(item)
  }
  return out
}

function wireOfRecord(record: object, depth: number, compact: boolean): unknown[] | undefined {
  const proto = Object.getPrototypeOf(record)
  if (proto !== Object.prototype && proto !== null) return undefined
  const out: unknown[] = ['m']
  for (const [key, item] of Object.entries(record)) {
    if (compact && item === undefined) continue
    const wire = isWellFormed(key) ? wireOf(item, depth + 1, compact) : undefined
    if (wire === undefined) return undefined
    out.push(key, wire)
  }
  return out
}
