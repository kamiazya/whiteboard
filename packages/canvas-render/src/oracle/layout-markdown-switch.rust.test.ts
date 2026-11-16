import { readFileSync } from 'node:fs'
import { type Core, type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import type { Scene } from '@kamiazya/whiteboard-scene'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  layoutCommentDocument,
  layoutMarkdownDocument,
  type MarkdownDocumentOptions,
} from '../layout/markdown-switch.js'
import { referenceSeamsFromWire } from '../references/wire.js'
import { fakeLayoutCore } from '../test-utils/fake-layout-core.js'
import { createFakeMeasure } from '../test-utils/fake-measure.js'
import {
  bodyName,
  type MarkdownMeta,
  type MarkdownRecord,
  PAST_THE_PARSER,
  sortedSceneDigest,
} from '../test-utils/markdown-document-oracle/oracle.js'
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

function surface(name: string): { meta: MarkdownMeta; records: MarkdownRecord[] } {
  const [head = '', ...lines] = readFileSync(new URL(`layout-markdown.${name}.jsonl`, DIR), 'utf8')
    .trimEnd()
    .split('\n')
  return { meta: JSON.parse(head) as MarkdownMeta, records: lines.map((l) => JSON.parse(l)) }
}

/** The options a root hands the switch for `record`, rebuilt from the record and its file's meta line. */
function optionsOf(
  record: MarkdownRecord,
  meta: MarkdownMeta,
): Omit<MarkdownDocumentOptions, 'core'> {
  const fonts = new Set(record.fonts ?? [])
  const style = record.surface === 'daemon' ? record.style : 'document'
  return {
    measure: createFakeMeasure(),
    maxWidth: record.maxWidth,
    mode: record.mode ?? 'light',
    ...(style === undefined ? {} : { style: style as MarkdownDocumentOptions['style'] }),
    ...(record.fonts === undefined ? {} : { fontAvailable: (family: string) => fonts.has(family) }),
    ...(record.references === true ? { references: referenceSeamsFromWire(meta.references) } : {}),
    ...(record.library === true ? { tagLibrary: meta.library } : {}),
    ...(record.fragments === undefined
      ? {}
      : { fragments: record.fragments === 'full' ? meta.fragments : [] }),
    ...(record.section === undefined ? {} : { section: record.section }),
  }
}

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
    return layoutMarkdownDocument(record.body, { ...optionsOf(record, meta), core })
  }

  /** The recorded scene's sorted digest; undefined for a section it missed, or a record held only as a digest. */
  const recorded = (record: MarkdownRecord) =>
    'scene' in record ? sortedSceneDigest(JSON.parse(record.scene)) : undefined
  const drawn = (scene: Scene | undefined) =>
    scene === undefined ? undefined : sortedSceneDigest(scene)

  for (const name of SURFACES) {
    it(`answers every ${name} note as the TypeScript recorded it`, { timeout: 120_000 }, () => {
      const { meta, records } = surface(name)
      let answered = 0
      for (const record of records) {
        const scene = lay(record, meta)
        if ('refused' in record) {
          expect(scene, record.id).toBeUndefined()
        } else if (PAST_THE_PARSER.has(bodyName(record.id))) {
          expect(scene?.refusal, record.id).toBeUndefined()
          if ('scene' in record) expect(drawn(scene), record.id).not.toEqual(recorded(record))
        } else if ('scene' in record) {
          answered += 1
          expect(drawn(scene), record.id).toEqual(recorded(record))
        }
      }
      expect(answered).toBeGreaterThan(20)
    })
  }
})
