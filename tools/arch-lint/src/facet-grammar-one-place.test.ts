/**
 * The facet key grammar (`{namespace}.{name}/v{n}`, ADR-0013 decision 2) has
 * a home per side of a package boundary and nowhere else.
 *
 * `model` and `facet-engine` are both "zod only", so neither can import the
 * other and each owns a copy; `facet-engine`'s `facet-grammar.test.ts` holds
 * the two equal. Everything ABOVE `facet-engine` (the registry, the stencil
 * and theme schemas, plugin-visual's facet schemas) imports its patterns and
 * keeps only its own refusal MESSAGE, which is the part of a schema worth
 * writing locally. Before this scan the segment was re-spelled in six more
 * places, and a loosening in one of them (say, digits in a segment) was
 * rejected by the rest with no failing test pointing at the cause.
 */
import { readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, SCAN_ROOTS } from './scan-roots.js'
import { isTestPath, walkSourceFiles } from './source-scan.js'

/** The segment grammar as it is written inside every one of the patterns. */
const SEGMENT = '[a-z][a-z0-9-]*'

/** Both-sided: each must still spell the segment, and the ceiling is pinned. */
const ALLOWLIST: Readonly<Record<string, string>> = {
  'packages/facet-engine/src/facet-grammar.ts':
    'the engine side: every registry, schema and plugin',
  'packages/model/src/facets.ts': 'the model side: the stored `facets` bucket key',
  'packages/model/src/tags.ts': 'a scoped tag half is the same segment grammar (ADR-0040)',
}

const files: string[] = []
for (const dir of SCAN_ROOTS) walkSourceFiles(join(REPO_ROOT, dir), files)
const production = files.filter((path) => !isTestPath(path))
const relOf = (path: string) => relative(REPO_ROOT, path).split(sep).join('/')
const spellsSegment = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8').includes(SEGMENT)

describe('the facet key segment grammar is written in one place per side', () => {
  it('scans a tree worth scanning', () => {
    expect(production.length).toBeGreaterThan(500)
  })

  it('no production source outside the allowlist spells the segment', () => {
    const hits = production
      .map(relOf)
      .filter((rel) => ALLOWLIST[rel] === undefined)
      .filter(spellsSegment)
    expect(
      hits,
      'import FACET_SEGMENT_PATTERN / FACET_KEY_PATTERN / FACET_NAMESPACED_ID_PATTERN from @kamiazya/whiteboard-facet-engine and keep only the refusal message locally',
    ).toEqual([])
  })

  it('every allowlist entry still spells the segment', () => {
    const stale = Object.keys(ALLOWLIST).filter((rel) => !spellsSegment(rel))
    expect(
      stale,
      'an entry that outlives its pattern is how an allowlist stops being read',
    ).toEqual([])
  })

  it('holds the allowlist at its declared ceiling', () => {
    expect(Object.keys(ALLOWLIST)).toHaveLength(3)
  })
})
