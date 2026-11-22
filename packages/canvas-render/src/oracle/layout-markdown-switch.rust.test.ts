import { readFileSync } from 'node:fs'
import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { beforeAll, describe, expect, it } from 'vitest'
import { layoutCommentDocument, layoutMarkdownDocument } from '../layout/markdown-switch.js'
import { referenceSeamsFromWire } from '../references/wire.js'
import { fakeLayoutCore } from '../test-utils/fake-layout-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import {
  bodyName,
  type MarkdownMeta,
  type MarkdownRecord,
  NAMES_A_NAME_ONLY_EMBED,
  PAST_THE_PARSER,
  renamedScene,
  sortedSceneDigest,
} from '../test-utils/markdown-document-oracle/oracle.js'
import { noteOptionsOf, recordedSurface } from '../test-utils/markdown-document-oracle/replay.js'
import { built, requireWasm, wasmBytes } from '../test-utils/wasm/glue.js'

/**
 * S18a's note and comment recordings through canvas-render's markdown entry
 * over the REAL core, as a root lays a note or a comment out: the core's scene
 * is what the caller gets, and it is the TypeScript's, but for the bodies past
 * the parser's bounds, which it draws as their literal text (owner decision
 * q81, D7a) and which must differ. Every surface hands its options as data.
 */
const DIR = new URL('./', import.meta.url)
const SURFACES = ['daemon', 'preview', 'outline', 'thumbnail', 'comment'] as const

/** The digests of the recorded scenes too long to hold whole (`layout-markdown-digests.jsonl`). */
const digests = new Map(
  readFileSync(new URL('layout-markdown-digests.jsonl', DIR), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: string; n: number; h: number })
    .map(({ id, n, h }) => [id, { n, h }] as const),
)

describe.runIf(built)('the recorded notes through the core', () => {
  // Made in `beforeAll`, not in this factory: vitest runs a skipped suite's
  // factory to collect it, so a core made here fails the file where there is
  // no artifact instead of skipping it.
  let real: Core
  beforeAll(() => {
    real = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  })

  const lay = (record: MarkdownRecord, meta: MarkdownMeta) => {
    const core = fakeLayoutCore({ markdown: real })
    if (record.surface === 'comment') {
      // As `CommentBody.tsx` lays a comment out: its measurer, width and density.
      const options = {
        measure: createFakeMeasure(),
        maxWidth: record.maxWidth,
        density: record.density ?? 'comfortable',
      } as const
      return layoutCommentDocument(record.body, { ...options, core })
    }
    return layoutMarkdownDocument(record.body, { ...noteOptionsOf(record, meta), core })
  }

  /** The recorded scene's sorted digest; undefined for a section it missed, or a record held only as a digest. */
  const recorded = (record: MarkdownRecord) =>
    'scene' in record ? sortedSceneDigest(JSON.parse(record.scene)) : undefined
  const drawn = (scene: Scene | undefined) =>
    scene === undefined ? undefined : sortedSceneDigest(scene)

  for (const name of SURFACES) {
    it(`answers every ${name} note as the TypeScript recorded it`, { timeout: 120_000 }, () => {
      const { meta, records } = recordedSurface(name)
      // Every branch asserts: a record that fell through would read as
      // replayed. A long scene is held by its digest alone.
      for (const record of records) {
        const scene = lay(record, meta)
        if ('refused' in record) {
          expect(scene, record.id).toBeUndefined()
        } else if (NAMES_A_NAME_ONLY_EMBED.has(record.id)) {
          expect('scene' in record, `${record.id} has a recorded scene`).toBe(true)
          if (!('scene' in record)) continue
          const want = sortedSceneDigest(JSON.parse(renamedScene(record.scene, meta)))
          expect(drawn(scene), record.id).toEqual(want)
        } else if (PAST_THE_PARSER.has(bodyName(record.id))) {
          expect(scene?.refusal, record.id).toBeUndefined()
          const held = 'scene' in record ? recorded(record) : digests.get(record.id)
          expect(held, `${record.id} has a recording`).toBeDefined()
          expect(drawn(scene), record.id).not.toEqual(held)
        } else if ('scene' in record) {
          expect(drawn(scene), record.id).toEqual(recorded(record))
        } else {
          const held = digests.get(record.id)
          expect(held, `${record.id} has a digest`).toBeDefined()
          expect(drawn(scene), record.id).toEqual(held)
        }
      }
      expect(records.length).toBeGreaterThan(20)
    })
  }

  it("draws a comment's reference as the title it resolves to when handed the bundle", () => {
    const core = fakeLayoutCore({ markdown: real })
    const options = { measure: createFakeMeasure(), maxWidth: 400, core } as const
    const references = referenceSeamsFromWire({
      entries: [['notes', { documentId: 'D-NOTES', name: 'Design notes' }]],
      aliases: [],
      titles: [['D-NOTES', 'Design notes']],
      extras: [],
    })
    const text = (scene: Scene) => JSON.stringify(scene)
    expect(text(layoutCommentDocument('see [[notes]]', { ...options, references }))).toContain(
      'Design notes',
    )
    expect(text(layoutCommentDocument('see [[notes]]', options))).not.toContain('Design notes')
  })
})
