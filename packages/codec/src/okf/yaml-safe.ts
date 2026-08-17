import { z } from 'zod'

/**
 * A value is not yaml-safe once it can no longer round-trip through a YAML
 * document: `undefined` (YAML has no concept of it — only `null`), non-finite
 * numbers (`NaN`/`Infinity` have no YAML 1.1/1.2 core-schema tag this repo
 * emits), and any JS value with no textual representation at all (bigint,
 * function, symbol). Cyclic references are rejected for the same reason a
 * cycle can never serialize to a finite document.
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
    if (node === undefined) {
      ctx.addIssue({ code: 'custom', message: 'undefined is not yaml-safe', path })
      return
    }
    if (typeof node === 'number' && !Number.isFinite(node)) {
      ctx.addIssue({ code: 'custom', message: `${node} is not yaml-safe`, path })
      return
    }
    if (typeof node === 'bigint' || typeof node === 'function' || typeof node === 'symbol') {
      ctx.addIssue({ code: 'custom', message: `${typeof node} is not yaml-safe`, path })
      return
    }
    if (node === null || typeof node !== 'object') return

    if (ancestors.includes(node)) {
      ctx.addIssue({ code: 'custom', message: 'cyclic reference is not yaml-safe', path })
      return
    }
    ancestors.push(node)

    if (Array.isArray(node)) {
      for (const [index, item] of node.entries()) {
        walk(item, [...path, index])
      }
    } else {
      for (const [key, item] of Object.entries(node)) {
        walk(item, [...path, key])
      }
    }

    ancestors.pop()
  }

  walk(value, [])
})
