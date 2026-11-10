import { MAX_BYTES, MAX_DEPTH } from './limits.js'

/**
 * Whether an input is one the Rust core is entitled to decline, judged by
 * machinery that shares nothing with the core: the host's own `JSON.parse`, a
 * scan of the text, a walk of the canvas. A decline the core gives for an input
 * that fails its predicate is a defect, not a decline, so the live
 * differential asks it of every decline it meets.
 */

const isWellFormed = (s: string): boolean =>
  (s as string & { isWellFormed(): boolean }).isWellFormed()

/** The deepest `[` or `{` nesting of a text, ignoring what sits inside strings. */
export function nesting(text: string): number {
  let [depth, deepest, inString, escaped] = [0, 0, false, false]
  for (const c of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '[' || c === '{') deepest = Math.max(deepest, ++depth)
    else if (c === ']' || c === '}') depth = Math.max(0, depth - 1)
  }
  return deepest
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Every string and key of a value, as the host holds them. */
function* strings(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value
  else if (Array.isArray(value)) for (const item of value) yield* strings(item)
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      yield key
      yield* strings(item)
    }
  }
}

/** A `\\u` escape of a surrogate, joined to its pair or not. */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Whether a text has a link node the core would have to judge the URL of. */
function hasLinkNode(text: string): boolean {
  const root = parsed(text)
  const nodes = isRecord(root) ? root.nodes : undefined
  return Array.isArray(nodes) && nodes.some((n) => isRecord(n) && n.type === 'link')
}

/** What `parseSpatial` declines, by the class the core gives and the input that earns it. */
export function readDeclineEarned(reason: string, text: string): boolean {
  switch (reason) {
    case 'lone-surrogate': {
      if (!isWellFormed(text)) return true
      const value = parsed(text)
      // A text that is not JSON is still declined at the first surrogate escape
      // the reader meets, before it reaches the fault that makes it not JSON.
      if (value === undefined) return SURROGATE_ESCAPE.test(text)
      return [...strings(value)].some((s) => !isWellFormed(s))
    }
    case 'too-deep':
      return nesting(text) > MAX_DEPTH
    case 'url':
      return hasLinkNode(text)
    case 'too-large':
      return new TextEncoder().encode(text).length > MAX_BYTES
    default:
      return false
  }
}

function* values(value: unknown): Generator<unknown> {
  yield value
  if (Array.isArray(value)) for (const item of value) yield* values(item)
  else if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) yield* values(item)
  }
}

/** The deepest nesting of arrays and objects in a value. */
function depthOf(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  return 1 + Math.max(0, ...Object.values(value).map(depthOf))
}

/** Whether a value is something the canvas wire cannot spell, found by walking it. */
function wireless(canvas: unknown): boolean {
  if (depthOf(canvas) > 100) return true
  for (const v of values(canvas)) {
    if (typeof v === 'function' || typeof v === 'symbol') return true
    if (typeof v === 'string' && !isWellFormed(v)) return true
    if (Array.isArray(v) && (v.includes(undefined) || Object.keys(v).length !== v.length)) {
      return true
    }
    if (isRecord(v)) {
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) return true
      if (Object.keys(v).some((k) => !isWellFormed(k))) return true
    }
  }
  return false
}

const hasKind = (v: unknown, kind: string): boolean => typeof v === kind

const only = (record: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(record).every((key) => record[key] === undefined || allowed.includes(key))

/** Whether `value`, when present, is a record whose present keys are `allowed`. */
function recordOf(
  value: unknown,
  allowed: readonly string[],
  check: (r: Record<string, unknown>) => boolean,
): boolean {
  return value === undefined || (isRecord(value) && only(value, allowed) && check(value))
}

const stringsOnly = (v: unknown): boolean =>
  v === undefined || (Array.isArray(v) && v.every((s) => typeof s === 'string'))

const oneOf = (v: unknown, options: readonly string[]): boolean =>
  v === undefined || (typeof v === 'string' && options.includes(v))

const SIDES = ['top', 'right', 'bottom', 'left']
const ARROWS = ['none', 'arrow']
const point = (p: unknown): boolean =>
  isRecord(p) && only(p, ['x', 'y']) && hasKind(p.x, 'number') && hasKind(p.y, 'number')
const bends = (b: unknown): boolean => b === undefined || (Array.isArray(b) && b.every(point))
const facets = (f: unknown): boolean => f === undefined || isRecord(f)
const optionalString = (v: unknown): boolean => v === undefined || typeof v === 'string'

function carriesNode(n: unknown): boolean {
  if (!isRecord(n)) return false
  const keys = ['id', 'x', 'y', 'width', 'height', 'color', 'embed', 'facets', 'tags']
  const more = ['resource', 'label', 'background', 'backgroundStyle']
  return (
    only(n, [...keys, ...more]) &&
    hasKind(n.id, 'string') &&
    ['x', 'y', 'width', 'height'].every((k) => hasKind(n[k], 'number')) &&
    [n.color, n.label, n.background].every(optionalString) &&
    oneOf(n.backgroundStyle, ['cover', 'ratio', 'repeat']) &&
    recordOf(n.embed, ['documentId', 'versionRef'], (e) => hasKind(e.documentId, 'string')) &&
    recordOf(n.resource, ['mimeType', 'content', 'location', 'subpath'], (r) =>
      hasKind(r.mimeType, 'string'),
    ) &&
    facets(n.facets) &&
    stringsOnly(n.tags)
  )
}

const edgeEnd = (e: unknown): boolean =>
  isRecord(e) &&
  only(e, ['node', 'side', 'end']) &&
  hasKind(e.node, 'string') &&
  oneOf(e.side, SIDES) &&
  oneOf(e.end, ARROWS)

function lineEnd(e: unknown): boolean {
  if (!isRecord(e)) return false
  if (e.kind === 'node') {
    return only(e, ['kind', 'node', 'side', 'end']) && edgeEnd({ ...e, kind: undefined })
  }
  return (
    e.kind === 'point' &&
    only(e, ['kind', 'point', 'end']) &&
    point(e.point) &&
    oneOf(e.end, ARROWS)
  )
}

function carriesEdge(e: unknown): boolean {
  if (!isRecord(e)) return false
  return (
    only(e, ['id', 'from', 'to', 'color', 'label', 'bends', 'facets', 'tags']) &&
    hasKind(e.id, 'string') &&
    edgeEnd(e.from) &&
    edgeEnd(e.to) &&
    [e.color, e.label].every(optionalString) &&
    bends(e.bends) &&
    facets(e.facets) &&
    stringsOnly(e.tags)
  )
}

function carriesLine(l: unknown): boolean {
  if (!isRecord(l)) return false
  return (
    only(l, ['id', 'from', 'to', 'color', 'label', 'bends', 'facets']) &&
    hasKind(l.id, 'string') &&
    lineEnd(l.from) &&
    lineEnd(l.to) &&
    [l.color, l.label].every(optionalString) &&
    bends(l.bends) &&
    facets(l.facets)
  )
}

/**
 * Whether a value is a canvas of the shape the wire carries, by the contract's
 * own field names and kinds, written out here and not read off the core: a
 * canvas of another shape (a key the contract does not name, a field of another
 * kind) is declined for the TypeScript to answer. A key set to `undefined` is
 * absent, as it is on the wire.
 */
export function carriesCanvas(canvas: unknown): boolean {
  if (!isRecord(canvas) || !only(canvas, ['nodes', 'edges', 'lines', 'facets', 'tags'])) {
    return false
  }
  const list = (v: unknown, one: (item: unknown) => boolean) => Array.isArray(v) && v.every(one)
  return (
    list(canvas.nodes, carriesNode) &&
    list(canvas.edges, carriesEdge) &&
    (canvas.lines === undefined || list(canvas.lines, carriesLine)) &&
    facets(canvas.facets) &&
    stringsOnly(canvas.tags)
  )
}

/** What `serializeSpatial` declines, by the class the core gives and the input that earns it. */
export function writeDeclineEarned(reason: string, canvas: unknown): boolean {
  switch (reason) {
    case 'wire':
      return wireless(canvas) || !carriesCanvas(canvas)
    case 'unwritable':
      return [...values(canvas)].some((v) => typeof v === 'bigint')
    case 'url': {
      const nodes = isRecord(canvas) && Array.isArray(canvas.nodes) ? canvas.nodes : []
      return nodes.some(
        (n) => isRecord(n) && isRecord(n.resource) && n.resource.mimeType === 'text/uri-list',
      )
    }
    default:
      return false
  }
}
