import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { layoutCases } from './layout-cases.js'

/** A recorded request and what the TypeScript answered it, as the shim spells both. */
interface LayoutRecord {
  readonly id: string
  readonly request: string
  readonly answer: string
}

/**
 * The committed recordings of what the TypeScript laid out for each request
 * the core can be handed, one file per topic of `layout-cases.ts`
 * (`layout-spatial-canvas.<topic>.jsonl`), taken before the TypeScript
 * composer was deleted (ADR-0054 step 7, S18h) and frozen. The crate replays
 * every topic file through the export itself
 * (`crates/bindings/wasm/tests/layout_oracle.rs`), so cargo-mutants judges the
 * request decoder, the reference host and the answer's writer by the
 * TypeScript's answers; this test holds the recording to what it must reach.
 */
const DIR = new URL('./oracle/', import.meta.url)
const TOPIC_FILE = /^layout-spatial-canvas\.([a-z0-9-]+)\.jsonl$/

const fileOf = (topic: string) => new URL(`layout-spatial-canvas.${topic}.jsonl`, DIR)

describe('the recorded whole-layout oracle', () => {
  const recorded = new Map(
    readdirSync(DIR).flatMap((name) => {
      const topic = TOPIC_FILE.exec(name)?.[1]
      if (topic === undefined) return []
      const records = readFileSync(fileOf(topic), 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as LayoutRecord)
      return [[topic, records] as const]
    }),
  )
  const all = [...recorded.values()].flat()

  it('holds a file for every topic and a topic for every file', () => {
    const topics = new Set(layoutCases(8).map((c) => c.topic))
    expect([...recorded.keys()].sort()).toEqual([...topics].sort())
    expect(recorded.size).toBeGreaterThan(1)
  })

  it('holds every option the request carries, and fences asked for', () => {
    const requests = all.map((r) => r.request).join('\n')
    for (const field of [
      'geometry',
      'lockedNodeIds',
      'suppressedBodyNodeIds',
      'sideOverrides',
      'tagLibrary',
      'embedPath',
      'references',
      '"dark"',
      '"style"',
      '"fontFamilies"',
      '"threads"',
      '"commentLayer"',
      '"showResolved"',
      '"commentObstacles"',
      '"proposals"',
    ]) {
      expect(requests, field).toContain(field)
    }
    // A per-node expansion policy crosses as the ids it opens.
    expect(requests).toMatch(/"expand",\["s",/)
    expect(all.filter((r) => r.answer.startsWith('["refused"'))).toEqual([])
    const asked = all.filter((r) => r.answer.startsWith('["needs"'))
    expect(asked.length, 'layouts asking for fences').toBeGreaterThan(2)
    expect(all.filter((r) => r.request.includes('"codeTokens"'))).toHaveLength(asked.length)
    const shortcodes = (recorded.get('shortcode') ?? []).map((r) => r.answer).join('\n')
    expect(shortcodes, 'an emoji expanded').toContain('🚀')
    expect(shortcodes, 'an icon drawn').toContain('{"kind":"icon","name":"star"}')
    const themed = (recorded.get('theme') ?? []).map((r) => r.answer).join('\n')
    expect(themed, 'a theme nobody registered').toContain('"kind":"unknown-theme"')
    expect(themed, 'a family the surface lacks').toContain('"kind":"font-missing"')
    expect(themed, 'a family the surface holds').toContain('"fontFamily":"Yomogi"')
    expect(themed, 'sketch ink').toContain('"style":"sketch"')
    const comments = (recorded.get('comments') ?? []).map((r) => r.answer).join('\n')
    for (const part of ['/pin"', '/bubble"', '/leader"', '/region"', '/passage-0"', '"Resolved"']) {
      expect(comments, part).toContain(part)
    }
    const tabled = recorded.get('fragments') ?? []
    expect(
      tabled.every((r) => r.request.includes('"fragments"')),
      'a table on every request',
    ).toBe(true)
    const drawn = tabled.map((r) => r.answer).join('\n')
    for (const part of ['<g data-sum/>', '<g data-graph/>', '<g data-euler/>', '<g data-q/>']) {
      expect(drawn, part).toContain(part)
    }
    expect(drawn, 'a source the table lacked').toContain('{"kind":"diagram","lang":"mermaid"')
    expect(drawn, 'inline math is never asked for').not.toContain('"value":"a+b"')
    const proposed = (recorded.get('proposals') ?? []).map((r) => r.answer).join('\n')
    for (const part of ['/outline"', '/bubble"', '/leader"', '"proposalChrome"', 'needs a']) {
      expect(proposed, part).toContain(part)
    }
    expect(
      all.filter((r) => r.answer.includes('"kind":"unknown-node-kind"')).length,
    ).toBeGreaterThan(0)
  })
})
