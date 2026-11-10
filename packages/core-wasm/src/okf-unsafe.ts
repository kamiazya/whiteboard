import { compareCodeUnit, holdsReservedKey, RESERVED_MAP_KEY } from '@kamiazya/whiteboard-model'

// Where a frontmatter value has no YAML spelling, worded as the TypeScript
// writer's `yamlSafeValueSchema` words it (`packages/codec/src/okf/yaml-safe.ts`).
// The artifact reports the places it can see (a number, a bigint, a byte-order
// mark, a reserved key) and the reason; this module words those, and walks the
// value itself when the wire cannot carry it, since a value the host holds but
// no wire spells (an `undefined`, a function, a class instance, a cycle, a
// lone surrogate) is invisible to the artifact. The two are held to the
// TypeScript's issues, text and order, by codec's layer-1 serialize suite.

/** One place a value has no spelling: a path of keys and list indexes, and why. */
export interface UnwritableIssue {
  readonly path: (string | number)[]
  readonly message: string
}

/** What the artifact says is wrong at a place: `okf.rs`'s reasons. */
export const REASON_MESSAGE: Readonly<Record<string, string>> = Object.freeze({
  nan: 'NaN is not yaml-safe',
  infinity: 'Infinity is not yaml-safe',
  'negative-infinity': '-Infinity is not yaml-safe',
  'big-int': 'bigint is not yaml-safe',
  'byte-order-mark': 'a byte-order mark is not yaml-safe',
  'reserved-key': `a key named "${RESERVED_MAP_KEY}" is not yaml-safe`,
})

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const BYTE_ORDER_MARK = '\uFEFF'

function textUnsafety(text: string): string | undefined {
  if (text.includes(BYTE_ORDER_MARK)) return REASON_MESSAGE['byte-order-mark']
  return LONE_SURROGATE.test(text) ? 'a lone UTF-16 surrogate is not yaml-safe' : undefined
}

function scalarUnsafety(node: unknown): string | undefined {
  if (typeof node === 'string') return textUnsafety(node)
  if (node === undefined) return 'undefined is not yaml-safe'
  if (typeof node === 'number' && !Number.isFinite(node)) return `${node} is not yaml-safe`
  if (typeof node === 'bigint' || typeof node === 'function' || typeof node === 'symbol') {
    return `${typeof node} is not yaml-safe`
  }
  return undefined
}

function isPlainContainer(node: object): boolean {
  if (Array.isArray(node)) return true
  const prototype = Object.getPrototypeOf(node)
  return prototype === Object.prototype || prototype === null
}

/** Why a container cannot be written whole: a class instance, or a cycle among its `ancestors`. */
function containerUnsafety(node: object, ancestors: readonly object[]): string | undefined {
  if (!isPlainContainer(node)) {
    return `${node.constructor.name} is not yaml-safe; use a plain list or mapping`
  }
  return ancestors.includes(node) ? 'cyclic reference is not yaml-safe' : undefined
}

/** A record's entries in `compareCodeUnit` order, as the writer spreads a bucket. */
function canonical(record: Record<string, unknown> | undefined): Record<string, unknown> {
  if (record === undefined) return {}
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareCodeUnit)
      .map((key) => [key, record[key]]),
  )
}

/**
 * The frontmatter as the writer spreads it: preserved keys at the root they
 * came from, `facets` last, so a path names what the written YAML names.
 */
function spread(frontmatter: object): Record<string, unknown> {
  const { facets, facetsRaw, ...rest } = frontmatter as Record<string, unknown>
  return {
    ...rest,
    ...canonical(facetsRaw as Record<string, unknown> | undefined),
    ...(facets === undefined ? {} : { facets: canonical(facets as Record<string, unknown>) }),
  }
}

/** Each place `frontmatter` has no YAML spelling, in the order the TypeScript reports them. */
export function unsafeIssues(frontmatter: object): UnwritableIssue[] {
  const issues: UnwritableIssue[] = []
  const root = spread(frontmatter)
  const add = (path: (string | number)[], message: string | undefined): void => {
    if (message !== undefined) issues.push({ path, message })
  }
  if (holdsReservedKey(root)) add([], REASON_MESSAGE['reserved-key'])
  // Ancestors, not everything seen: one object under two keys is no cycle.
  const ancestors: object[] = []
  const walk = (node: unknown, path: (string | number)[]): void => {
    const unsafe = scalarUnsafety(node)
    if (unsafe !== undefined || node === null || typeof node !== 'object') {
      add(path, unsafe)
      return
    }
    const refused = containerUnsafety(node, ancestors)
    if (refused !== undefined) {
      add(path, refused)
      return
    }
    ancestors.push(node)
    const children: [string | number, unknown][] = Array.isArray(node)
      ? [...node.entries()]
      : Object.entries(node)
    for (const [key] of children) add(path, typeof key === 'string' ? textUnsafety(key) : undefined)
    for (const [key, item] of children) walk(item, [...path, key])
    ancestors.pop()
  }
  walk(root, [])
  return issues
}
