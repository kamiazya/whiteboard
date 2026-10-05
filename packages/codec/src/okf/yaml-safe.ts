import { z } from 'zod'

/** Why a non-container value cannot round-trip through YAML, or `undefined` when it can. */
function scalarUnsafety(node: unknown): string | undefined {
  if (node === undefined) return 'undefined is not yaml-safe'
  if (typeof node === 'number' && !Number.isFinite(node)) return `${node} is not yaml-safe`
  if (typeof node === 'bigint' || typeof node === 'function' || typeof node === 'symbol') {
    return `${typeof node} is not yaml-safe`
  }
  return undefined
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
  // Ancestor stack (not a whole-traversal seen set): a DAG where one object
  // is legitimately referenced from two different branches is not cyclic
  // and must not be rejected — only a node that reappears among its own
  // ancestors is.
  const ancestors: object[] = []

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
    for (const [key, item] of children) walk(item, [...path, key])

    ancestors.pop()
  }

  walk(value, [])
})
