// A browser test that fails writes a Playwright trace, and vitest then COPIES
// that trace into `.vitest-attachments/` under a name flattened from its path.
// When that name exceeds the filesystem's 255-byte limit the copy throws
// ENAMETOOLONG — and the throw lands in the file's teardown, so vitest abandons
// the REST OF THE FILE.
//
// Measured, by forcing one failure in BrowserDocumentPage.rename twice:
//
//   failed test with a 194-char name -> ENAMETOOLONG, "1 failed | 2 passed (6)"
//   failed test with a  58-char name -> no error,     "1 failed | 5 passed (6)"
//
// Three tests silently did not run, and the run reported a smaller total —
// which reads like good news. The trace itself is fine either way (it is
// written to tmp/vitest-traces first, and only the copy fails), so the cost is
// entirely the lost coverage.
//
// A comment cannot hold this: the limit is only reached by names nobody counts.
// Source is captured at build time via `?raw` rather than read at runtime, so
// this stays free of `node:fs` — apps/web is browser-only (see
// web-app-boundary.test.ts).

import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('./**/*.browser.test.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** ext4/APFS both stop at 255 BYTES for a single path component. */
const NAME_LIMIT = 255

/**
 * The name as it reaches the filesystem. vitest replaces every non-alphanumeric
 * CHARACTER with one ASCII `-`, including multi-byte ones, so the sanitized
 * form is pure ASCII and its length in characters IS its length in bytes.
 *
 * Measured against a real attachment name: the title path
 * `…markdown 導線 (browser — real IndexedDB)-…-is editable…` is 207 characters
 * and 213 UTF-8 bytes raw, and landed on disk as 207 characters — `導`, `線`
 * and `—` each cost one dash, not three. Counting the raw title's bytes would
 * therefore reject titles that fit.
 */
const sanitize = (title: string): string => title.replace(/[^a-zA-Z0-9]/g, '-')

/**
 * What the attachment name costs before the test's own title:
 * `tmp-vitest-traces-` (the flattened `tracesDir`), `web-browser--chromium--`
 * (project + browser), and a `-0-0-trace-zip-<40-char sha>.zip` suffix.
 */
const FIXED_OVERHEAD = 'tmp-vitest-traces-'.length + 'web-browser--chromium--'.length + 59

const TITLE_BUDGET = NAME_LIMIT - FIXED_OVERHEAD

/**
 * Every `describe`/`it` title in a file, with nesting resolved by brace depth.
 * Titles built from a template with a substitution are skipped — their length
 * is not knowable here, and none of them are near the limit.
 */
function titlePaths(source: string): string[] {
  const paths: string[] = []
  const stack: { title: string; depth: number }[] = []
  let depth = 0
  const pattern = /\b(describe|it)(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)\2|[{}]/g
  for (const match of source.matchAll(pattern)) {
    const token = match[0]
    if (token === '{') {
      depth += 1
      continue
    }
    if (token === '}') {
      depth -= 1
      continue
    }
    const [, kind, , title] = match
    if (title === undefined || title.includes('${')) continue
    // A SIBLING describe opens at the same depth as the one that just closed,
    // so drop anything at or below this depth before pushing — otherwise every
    // sibling accumulates and the reported title path is one nobody wrote.
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop()
    if (kind === 'describe') stack.push({ title, depth })
    else paths.push([...stack.map((entry) => entry.title), title].join('-'))
  }
  return paths
}

describe('browser test names fit the trace attachment filename', () => {
  it('leaves no title over the budget, so one failure never abandons its file', () => {
    const files = Object.keys(sources)
    // A glob that silently matched nothing would make this guard vacuous.
    expect(files.length).toBeGreaterThan(50)

    const overBudget = files
      .flatMap((file) =>
        titlePaths(sources[file] ?? '').map((title) => ({
          file,
          title,
          length: sanitize(title).length,
        })),
      )
      .filter((entry) => entry.length > TITLE_BUDGET)
      .sort((a, b) => b.length - a.length)
      .map((entry) => `${entry.length}/${TITLE_BUDGET} ${entry.file}: ${entry.title}`)

    expect(
      overBudget,
      `these describe+it titles exceed ${TITLE_BUDGET} characters, so a failure in one abandons the rest of its file`,
    ).toEqual([])
  })
})
