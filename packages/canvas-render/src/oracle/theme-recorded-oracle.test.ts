import { readFileSync, writeFileSync } from 'node:fs'
import { VISUAL_THEMES } from '@kamiazya/whiteboard-plugin-visual'
import { describe, expect, it } from 'vitest'
import { themeCorpus } from '../test-utils/theme-oracle/corpus.js'
import {
  answerOf,
  type Json,
  type MetaRecord,
  type OracleRecord,
  type ResolverRecord,
  recording,
} from '../test-utils/theme-oracle/oracle.js'
import { createSpatialTheme } from '../theme/spatial-theme.js'

/**
 * The committed recording of the theme layer (palettes, the spatial theme's
 * resolvers, the markdown chrome) equals what the TypeScript answers today, and
 * the Rust port replays it exactly (`tests/theme_oracle.rs` in
 * `crates/core/canvas-render`). Re-record after a deliberate change with
 * `WHITEBOARD_RECORD_ORACLE=1 pnpm vitest run --project canvas-render-node theme-recorded`.
 */
const FILE = new URL('./theme.jsonl', import.meta.url)

if (process.env.WHITEBOARD_RECORD_ORACLE === '1') {
  writeFileSync(
    FILE,
    `${recording()
      .map((r) => JSON.stringify(r))
      .join('\n')}\n`,
  )
}

const text = readFileSync(FILE, 'utf8')
const lines = text.trimEnd().split('\n')
const recorded = lines.map((line) => JSON.parse(line) as OracleRecord)
const meta = recorded[0] as MetaRecord
const resolvers = recorded.filter((r): r is ResolverRecord => r.kind === 'resolver')

describe('the recorded theme layer', () => {
  it('records the corpus as it stands today, bundled themes included', () => {
    expect(meta.kind).toBe('meta')
    expect(meta.corpus).toEqual(JSON.parse(JSON.stringify(themeCorpus())))
    expect(meta.corpus.themes.sketch).toEqual(VISUAL_THEMES.sketch)
    expect(meta.corpus.themes.neon).toEqual(VISUAL_THEMES.neon)
  })

  it('reaches every resolver, palette and markdown pair of the corpus', () => {
    const per = (kind: OracleRecord['kind']) => recorded.filter((r) => r.kind === kind).length
    expect(per('resolver')).toBe(meta.corpus.resolvers.length)
    expect(per('palette')).toBe(2 * (1 + Object.keys(meta.corpus.themes).length))
    expect(per('markdown')).toBe(meta.corpus.markdown.length)
    const cells = meta.corpus.nodeKinds.length * meta.corpus.colors.length
    expect(cells).toBeGreaterThan(100)
    for (const r of resolvers) {
      expect(r.out.nodes).toHaveLength(cells)
      expect(r.out.edges).toHaveLength(meta.corpus.colors.length)
    }
  })

  it('equals what the TypeScript answers today', () => {
    const differs = recorded.findIndex(
      (r, i) => JSON.stringify(answerOf(meta.corpus, r)) !== lines[i],
    )
    expect(
      recorded[differs] === undefined ? undefined : (recorded[differs] as { id?: string }).id,
      'the first recorded input the TypeScript no longer answers as recorded',
    ).toBeUndefined()
  })

  it('records answers that differ by mode, by theme and by colour', () => {
    const nodes = (id: string): readonly Json[] =>
      resolvers.find((r) => r.id === id)?.out.nodes ?? []
    const light = JSON.stringify(nodes('bundled/light/-'))
    expect(light).not.toBe(JSON.stringify(nodes('bundled/dark/-')))
    expect(light).not.toBe(JSON.stringify(nodes('sketch/light/Roboto')))
    expect(new Set(nodes('bundled/light/-').map((n) => JSON.stringify(n))).size).toBeGreaterThan(8)
  })

  it('holds the records the TypeScript tests pin, so a drifted fixture shows here too', () => {
    const light = createSpatialTheme({ mode: 'light' })
    expect(light.resolveLabel().halo).toBe('#ffffff')
    const bundledLabel = resolvers.find((r) => r.id === 'bundled/light/-')?.out.label
    expect(bundledLabel).toMatchObject({ halo: '#ffffff', fill: '#404040' })
  })
})
