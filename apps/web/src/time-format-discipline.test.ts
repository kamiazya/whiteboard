// Every human-readable timestamp in this app goes through ONE formatter,
// `workspace-files/format-relative.ts`: "5m ago" while fresh, the reader's
// local M/D HH:MM once age stops being the fact. It says so in its own
// comment — "one formatter with a parameter, because the fork this replaces
// diverged silently" — and was forked anyway: the annotation layer's stamp
// hand-rolled a UTC ISO slice for CI determinism and shipped every reader a
// clock that was not theirs. A rule in a comment is read by whoever opens
// that file; this reads every file instead.
//
// Source is captured at build time via `?raw` rather than read at runtime,
// so this stays free of `node:fs` — apps/web is browser-only.
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob(
  ['./**/*.ts', './**/*.tsx', '!./**/*.test.ts', '!./**/*.test.tsx'],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
) as Record<string, string>

/** The formatter itself is where these calls belong. */
const FORMATTER = './components/workspace-files/format-relative.ts'

/** Opt out on the line above, naming why this stamp is not one a reader reads. */
const ESCAPE = 'time-format-is-deliberate:'

const HAND_ROLLED_STAMP =
  /\.toLocale(?:Date|Time)?String\(|\.toISOString\(\)\.slice\(|Intl\.DateTimeFormat\(/

describe('time formatting discipline', () => {
  it('hand-rolls no timestamp outside format-relative.ts', () => {
    const offenders: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      if (path === FORMATTER) continue
      const lines = source.split('\n')
      lines.forEach((line, index) => {
        if (!HAND_ROLLED_STAMP.test(line)) return
        if (lines[index - 1]?.includes(ESCAPE)) return
        offenders.push(`${path}:${index + 1}: ${line.trim()}`)
      })
    }
    expect(
      offenders,
      `A timestamp a reader sees goes through formatRelative (${FORMATTER}); a stamp that is not for reading says so with "${ESCAPE} <why>" on the line above.`,
    ).toEqual([])
  })

  it('reads the tree it claims to', () => {
    expect(Object.keys(sources)).toContain(FORMATTER)
    expect(Object.keys(sources)).toContain('./components/annotations/message-meta.tsx')
  })
})
