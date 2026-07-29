import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `to-remark.ts` and `normalize.ts` convert between canvas-model's mdast
 * subset and plain objects shaped for mdast-util-to-markdown /
 * mdast-util-from-markdown. Neither direction has a stable exported type to
 * lean on, which made `any` an easy shortcut here in the past — this guard
 * keeps both files honest so a future edit can't silently reintroduce the
 * hole `z.infer`/`unknown`-narrowing is supposed to close.
 */
const GUARDED_FILES = ['to-remark.ts', 'normalize.ts']

const ANY_PATTERN = /:\s*any\b|\bas\s+any\b/

describe('markdown codec files avoid `any`', () => {
  it.each(GUARDED_FILES)('%s has no `: any` or `as any`', (filename) => {
    const path = fileURLToPath(new URL(filename, import.meta.url))
    const source = readFileSync(path, 'utf-8')
    expect(ANY_PATTERN.test(source)).toBe(false)
  })
})
