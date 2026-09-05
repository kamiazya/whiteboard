// @vitest-environment node
// One switcher, two keepers — and the switcher decides what to OFFER by
// asking whether its source carries the method. That is the mechanism behind
// DESIGN.md's "never offer what the keeper cannot honour", and it is invisible
// at the call site: a source missing `create` produces a menu with no create
// entry and no error anywhere.
//
// Which is right while the keeper genuinely cannot honour it, and became WRONG
// the moment the daemon published its write surface — with nothing to say so.
// The daemon's source went months without `create` behind a comment explaining
// why, and that comment stayed true only until the routes landed.
//
// So the two sources are pinned to offer the SAME set. A keeper that really
// cannot honour something needs this test changed, which is the point: the
// asymmetry becomes a decision on the record instead of a method somebody
// forgot to add.
//
// Read at build time via `?raw` rather than at runtime, so this stays free of
// `node:fs` — apps/web is browser-only (see web-app-boundary.test.ts).

import { describe, expect, it } from 'vitest'
import appSource from './App.tsx?raw'

/**
 * The `source: { ... }` literal that follows a declaration, as text.
 *
 * Deliberately textual, and deliberately dumb: the alternative is rendering
 * App twice with a live daemon and a live registry, which tests a great deal
 * besides the question asked here. An earlier version of this walked the
 * literal and enumerated every key it found, which picked up tokens inside
 * nested arrow bodies and needed a fix per false positive — a guard that has
 * to be repaired whenever unrelated code moves is one somebody eventually
 * deletes. Asking whether three NAMED methods are declared cannot drift that
 * way.
 */
function sourceBlock(source: string, after: string): string {
  const start = source.indexOf(after)
  if (start < 0) return ''
  const open = source.indexOf('source: {', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open + 'source: '.length; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  return ''
}

const OFFERED = ['list', 'create', 'rename'] as const

describe('both keepers offer the same switcher affordances', () => {
  it.each([
    ['daemon', 'const daemonWorkspaces'],
    ['browser', 'const browserWorkspaces'],
  ])('%s declares list, create and rename', (_keeper, declaration) => {
    const block = sourceBlock(appSource, declaration)
    // A scan that found nothing would make every assertion below vacuous, and
    // would read as agreement rather than as a scan that missed.
    expect(block.length).toBeGreaterThan(100)
    for (const method of OFFERED) {
      expect(block).toContain(`${method}:`)
    }
  })
})
