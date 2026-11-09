import { holdsReservedKey, RESERVED_MAP_KEY } from '@kamiazya/whiteboard-model'
import { z } from 'zod'

/** Why a non-container value cannot round-trip through YAML, or `undefined` when it can. */
function scalarUnsafety(node: unknown): string | undefined {
  if (typeof node === 'string') return textUnsafety(node)
  if (node === undefined) return 'undefined is not yaml-safe'
  if (typeof node === 'number' && !Number.isFinite(node)) return `${node} is not yaml-safe`
  if (typeof node === 'bigint' || typeof node === 'function' || typeof node === 'symbol') {
    return `${typeof node} is not yaml-safe`
  }
  return undefined
}

/**
 * A string the frontmatter YAML subset has no spelling for. A lone UTF-16
 * surrogate is not a Unicode scalar value, so no UTF-8 reader can hold it; a
 * byte-order mark is refused by the reader wherever it sits, and `yaml` writes
 * one raw.
 */
const UNWRITABLE_TEXT =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\uFEFF/

function textUnsafety(text: string): string | undefined {
  const found = UNWRITABLE_TEXT.exec(text)
  if (found === null) return undefined
  return found[0] === '\uFEFF'
    ? 'a byte-order mark is not yaml-safe'
    : 'a lone UTF-16 surrogate is not yaml-safe'
}

/** Whether `node` is an object the store keeps as written: an array, or a record with no class. */
function isPlainContainer(node: object): boolean {
  if (Array.isArray(node)) return true
  const prototype = Object.getPrototypeOf(node)
  return prototype === Object.prototype || prototype === null
}

/**
 * A value is not yaml-safe once it can no longer round-trip through a YAML
 * document: `undefined` (YAML has no concept of it — only `null`), non-finite
 * numbers (`NaN`/`Infinity` have no YAML 1.1/1.2 core-schema tag this repo
 * emits), and any JS value with no textual representation at all (bigint,
 * function, symbol). Cyclic references are rejected for the same reason a
 * cycle can never serialize to a finite document.
 *
 * Two more shapes the YAML parser PRODUCES and the stored document cannot
 * hold, because a preserved key travels through a JSON-shaped store between
 * the write and the read: a non-plain object (`!!set` and `!!omap` parse to a
 * Set and a Map, `!!binary` to bytes — each flattens to `{}` or an array of
 * numbers). `parseOkf` hands an integer past 2^53 over as a bigint rather than
 * the rounded number, so the same refusal covers it. Refusing at the write
 * keeps the author holding the content. A spelling that parses to the same
 * number (`0x10`, `1e3`) is not refused: it is a normalisation, and
 * `docs/reference/export-formats.md` says so.
 *
 * Zod's own recursive schema composition (`z.lazy` walking into array/object
 * children) would recurse into a cyclic object exactly the way `JSON.stringify`
 * does and stack-overflow before ever reporting an issue. This schema instead
 * walks the value itself with an explicit `seen` set, entirely outside Zod's
 * built-in structural recursion, so a cycle is reported as a normal ZodError
 * instead of crashing the process.
 */
export const yamlSafeValueSchema: z.ZodType<unknown> = z.unknown().superRefine((value, ctx) => {
  // `parseOkf` refuses the key, so a value holding it would serialise to a
  // document nothing reads back.
  if (holdsReservedKey(value)) {
    ctx.addIssue({
      code: 'custom',
      message: `a key named "${RESERVED_MAP_KEY}" is not yaml-safe`,
      path: [],
    })
  }
  // Ancestor stack (not a whole-traversal seen set): a DAG where one object
  // is legitimately referenced from two different branches is not cyclic
  // and must not be rejected — only a node that reappears among its own
  // ancestors is.
  const ancestors: object[] = []

  // A key is text too; the issue sits on the mapping holding it, since the key
  // itself may be the unprintable part.
  function reportUnsafeKey(key: string | number, path: (string | number)[]): void {
    const unsafe = typeof key === 'string' ? textUnsafety(key) : undefined
    if (unsafe !== undefined) ctx.addIssue({ code: 'custom', message: unsafe, path })
  }

  function walk(node: unknown, path: (string | number)[]): void {
    const unsafe = scalarUnsafety(node)
    if (unsafe !== undefined) {
      ctx.addIssue({ code: 'custom', message: unsafe, path })
      return
    }
    if (node === null || typeof node !== 'object') return
    if (!isPlainContainer(node)) {
      ctx.addIssue({
        code: 'custom',
        message: `${node.constructor.name} is not yaml-safe; use a plain list or mapping`,
        path,
      })
      return
    }

    if (ancestors.includes(node)) {
      ctx.addIssue({ code: 'custom', message: 'cyclic reference is not yaml-safe', path })
      return
    }
    ancestors.push(node)

    const children: [string | number, unknown][] = Array.isArray(node)
      ? [...node.entries()]
      : Object.entries(node)
    for (const [key, item] of children) {
      reportUnsafeKey(key, path)
      walk(item, [...path, key])
    }

    ancestors.pop()
  }

  walk(value, [])
})
