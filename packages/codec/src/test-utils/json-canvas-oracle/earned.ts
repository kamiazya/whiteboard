/**
 * Whether an input is one the Rust core is entitled to decline, judged by
 * machinery that shares nothing with the core: the host's own `JSON.parse`, a
 * scan of the text, a walk of the canvas. A decline the core gives for an input
 * that fails its predicate is a defect, not a decline, so the recorded replay
 * asks it of every decline it meets. The numbers are the reader's limits as
 * `crates/input-caps.json` states them.
 */
const MAX_DEPTH = 64

const isWellFormed = (s: string): boolean =>
  (s as string & { isWellFormed(): boolean }).isWellFormed()

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The deepest `[` or `{` nesting of a text, ignoring what sits inside strings. */
function nesting(text: string): number {
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
  else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      yield key
      yield* strings(item)
    }
  }
}

/** A `\\u` escape of a surrogate, joined to its pair or not. */
const SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/

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
    default:
      return false
  }
}
