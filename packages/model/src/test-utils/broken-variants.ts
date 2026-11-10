/**
 * A deterministic damage to a JSON-shaped value, for recording what a schema
 * refuses: the same recording is replayed by the Rust interpreter, so the
 * variants have to reach the refusals a schema has (a dropped field, an
 * unknown key, a wrong type, an index-like key) rather than random noise.
 */

/** A small PRNG, so one drawn integer is a whole reproducible damage. */
export function randomFrom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const JUNK: readonly unknown[] = [
  null,
  true,
  0,
  -1,
  1.5,
  -0,
  1e21,
  '',
  ' ',
  'x',
  '#fff',
  '#GGGGGG',
  '#FF00AA',
  'Bad.Id',
  'visual.x',
  'visual.shape/v0',
  'é́',
  'ab',
  '\n',
  [],
  {},
  [1],
  { a: 1 },
]

const UNKNOWN_KEYS = ['zz', '7', '0', 'visual.shape/v0', 'Zz', '__proto__x']

type Container = Record<string, unknown> | unknown[]

const isContainer = (value: unknown): value is Container =>
  typeof value === 'object' && value !== null

function pick<T>(items: readonly T[], rand: () => number): T {
  return items[Math.floor(rand() * items.length)] as T
}

/** Every container in `value`, so the damage can land at any depth. */
function containers(value: unknown, found: Container[] = []): Container[] {
  if (!isContainer(value)) return found
  found.push(value)
  for (const item of Object.values(value)) containers(item, found)
  return found
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function damageObject(target: Record<string, unknown>, rand: () => number): void {
  const keys = Object.keys(target)
  const op = Math.floor(rand() * 4)
  if (op === 0 && keys.length > 0) {
    delete target[pick(keys, rand)]
  } else if (op === 1) {
    target[pick(UNKNOWN_KEYS, rand)] = pick(JUNK, rand)
  } else if (op === 2 && keys.length > 0) {
    target[pick(keys, rand)] = clone(pick(JUNK, rand))
  } else if (keys.length > 0) {
    const from = pick(keys, rand)
    target[pick(['1', '10', 'Upper', 'a b', ''], rand)] = target[from]
    delete target[from]
  }
}

function damageList(target: unknown[], rand: () => number): void {
  const op = Math.floor(rand() * 3)
  if (op === 0 && target.length > 0) target.splice(Math.floor(rand() * target.length), 1)
  else if (op === 1) target.push(clone(pick(JUNK, rand)))
  else if (target.length > 0) target[Math.floor(rand() * target.length)] = clone(pick(JUNK, rand))
}

/**
 * A copy of `valid` with one or two damages. A value with nothing to damage
 * (a bare leaf) is replaced outright.
 */
export function brokenVariant(valid: unknown, rand: () => number): unknown {
  const copy = clone(valid)
  const places = containers(copy)
  if (places.length === 0) return clone(pick(JUNK, rand))
  const rounds = rand() < 0.25 ? 2 : 1
  for (let round = 0; round < rounds; round += 1) {
    const place = pick(places, rand)
    if (Array.isArray(place)) damageList(place, rand)
    else damageObject(place, rand)
  }
  return copy
}
