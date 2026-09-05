// @vitest-environment node
/**
 * Guard: no test may drive a BROWSER shortcut whose chord differs per
 * platform.
 *
 * The one that actually bit: `{Control>}a{/Control}` to select a field's
 * contents. Select-all is Cmd+A on macOS and Ctrl+A everywhere else, so
 * that chord selects nothing on a Mac and whatever is typed next appends
 * to the old value instead of replacing it — a failure that looks like a
 * flake, reproduces only on one developer's machine, and passes CI (Linux)
 * forever. `userEvent.clear(el)` drives the field's own selection API and
 * means the same thing everywhere.
 *
 * Scope is deliberately narrow: this bans the chords the BROWSER owns, not
 * the app's own bindings. `{Control>}{Enter}{/Control}` stays legal because
 * the handler behind it accepts `metaKey || ctrlKey`, so the chord already
 * means the same thing on both platforms.
 */
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('./**/*.test.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/** Browser-owned chords whose modifier differs between macOS and the rest. */
const PLATFORM_DEPENDENT_CHORDS: readonly { pattern: RegExp; use: string }[] = [
  { pattern: /\{Control>\}a\{\/Control\}/, use: 'userEvent.clear(element)' },
  { pattern: /\{Meta>\}a\{\/Meta\}/, use: 'userEvent.clear(element)' },
]

/**
 * Comments are stripped before scanning: a test explaining WHY it avoids a
 * chord has to be able to name it, and this file itself is nothing but
 * such an explanation. Crude enough to mangle a comment marker inside a
 * string literal, which costs nothing here — the result is only ever fed
 * to these two chord patterns.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('test sources', () => {
  it('drive no platform-dependent browser shortcut', () => {
    const offenders: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      const code = withoutComments(source)
      for (const { pattern, use } of PLATFORM_DEPENDENT_CHORDS) {
        if (pattern.test(code)) offenders.push(`${path}: ${pattern.source} — use ${use}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
