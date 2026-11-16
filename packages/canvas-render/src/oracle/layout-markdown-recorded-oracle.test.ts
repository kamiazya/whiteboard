import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MarkdownMeta, MarkdownRecord } from '../test-utils/markdown-document-oracle/oracle.js'

/**
 * The committed recordings of what a markdown DOCUMENT lays out as on each
 * surface (`layout-markdown.<surface>.jsonl`, ADR-0054 step 7, S18a) equal
 * what the TypeScript answers today. They exist for the core's markdown entry,
 * which replays them once the TypeScript that wrote them is deleted.
 *
 * Each file's first line holds the reference wire, the fragment table and the
 * tag library its records name, and each record holds its body and options,
 * so this test reads no corpus: the freshness check re-answers the recorded
 * inputs. Re-record after a deliberate layout change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node layout-markdown-recorded`.
 */
const DIR = new URL('./', import.meta.url)
const SURFACE_FILE = /^layout-markdown\.([a-z]+)\.jsonl$/
const fileOf = (surface: string) => new URL(`layout-markdown.${surface}.jsonl`, DIR)

const files = new Map(
  readdirSync(DIR).flatMap((name) => {
    const surface = SURFACE_FILE.exec(name)?.[1]
    if (surface === undefined) return []
    const [head = '', ...lines] = readFileSync(fileOf(surface), 'utf8').trimEnd().split('\n')
    const meta = JSON.parse(head) as MarkdownMeta
    return [[surface, { meta, lines, records: lines.map((l) => JSON.parse(l) as MarkdownRecord) }]]
  }),
)
const all = [...files.values()].flatMap((f) => f.records)
const scenes = (surface: string) =>
  (files.get(surface)?.records ?? []).map((r) => ('scene' in r ? r.scene : '')).join('\n')

describe('the recorded markdown-document oracle', () => {
  it('holds a file for every surface the roots lay a document out on', () => {
    expect([...files.keys()].sort()).toEqual([
      'comment',
      'daemon',
      'outline',
      'preview',
      'thumbnail',
    ])
  })

  it('reaches the corpus, the references, the fragments and the bounds', () => {
    const ids = all.map((r) => r.id)
    expect(ids.filter((id) => /^daemon\/docs\//.test(id)).length, 'docs').toBeGreaterThan(100)
    expect(ids.filter((id) => /\/skills\//.test(id)).length, 'skills').toBeGreaterThan(2)
    for (const bound of [
      'quote 33 deep',
      'list 40 deep',
      '1100 delimiter runs',
      'past the body cap',
    ])
      expect(
        ids.some((id) => id.includes(bound)),
        bound,
      ).toBe(true)
    const daemon = scenes('daemon')
    for (const part of [
      '"kind":"embedResolved"',
      '"reason":"cycle"',
      '"reason":"depthCap"',
      '"reason":"unresolvable"',
      '"kind":"edge"',
      '"kind":"unresolvedReference"',
      '"kind":"image"',
      '"kind":"codeBlock"',
      '"kind":"table"',
      '"fontFamily":"Yomogi"',
      '"style":"sketch"',
    ])
      expect(daemon.includes(part), part).toBe(true)
    // An embedded board's legend: a row for each value the library colours.
    expect(daemon.includes('"text":"failing"'), 'a legend').toBe(true)
    const preview = scenes('preview')
    for (const part of ['<g data-sum/>', '<g data-graph/>', '<g data-euler/>'])
      expect(preview.includes(part), part).toBe(true)
    const asked = all.flatMap((r) => ('asked' in r ? (r.asked ?? []) : []))
    expect(asked, 'a source the table lacked').toContainEqual({
      kind: 'diagram',
      lang: 'mermaid',
      value: 'sequenceDiagram\n  A->>B: hi',
    })
    expect(
      all.some((r) => 'refused' in r),
      'a section naming no heading',
    ).toBe(true)
    expect(new Set(all.map((r) => r.mode ?? 'light')).size, 'modes').toBe(2)
    expect(new Set(all.map((r) => r.density).filter(Boolean)).size, 'densities').toBe(2)
    expect(all.filter((r) => r.digest === true).length, 'digests').toBeGreaterThan(4)
  })
})
