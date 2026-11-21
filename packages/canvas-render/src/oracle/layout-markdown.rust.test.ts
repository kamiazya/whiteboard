import { readFileSync } from 'node:fs'
import { type CoreGlue, coreFrom } from '@kamiazya/whiteboard-core-wasm'
import { beforeAll, describe, expect, it } from 'vitest'
import { highlightCode } from '../highlight/lowlight.js'
import {
  bodyName,
  type MarkdownMeta,
  type MarkdownRecord,
  NAMES_A_NAME_ONLY_EMBED,
  PAST_THE_PARSER,
  sortedSceneDigest,
} from '../test-utils/markdown-document-oracle/oracle.js'
import { built, requireWasm, wasmBytes } from '../test-utils/wasm/glue.js'

/**
 * The core's markdown entry against the recorded TypeScript answers
 * (`layout-markdown.<surface>.jsonl`), through the shim as a root calls it:
 * each record's request built from its body and options and the file's meta
 * line, the highlighter answering the fences the core asks for. A recorded
 * scene is compared as a value, a long one by its sorted-key digest
 * (`layout-markdown-digests.jsonl`). The bodies past the parser's bounds are
 * a tolerated class (owner decision q81, D7a): the core draws each as its
 * literal text where the TypeScript drew remark's reading, so each must be
 * answered with a scene AND differ from the recording, and only those differ.
 * The native replay (`crates/bindings/wasm/tests/markdown_oracle.rs`) holds
 * the same.
 */
const DIR = new URL('./', import.meta.url)
const SURFACES = ['comment', 'daemon', 'outline', 'preview', 'thumbnail'] as const

type Core = ReturnType<typeof coreFrom>
type Request = Parameters<Core['layoutMarkdown']>[0]

const measure = { kind: 'fake', factor: 0.6 } as const

/** The request a root sends for `record`. */
function requestOf(record: MarkdownRecord, meta: MarkdownMeta): Request {
  const head = { body: record.body, maxWidth: record.maxWidth, measure }
  if (record.surface === 'comment') {
    return { kind: 'comment', ...head, density: record.density ?? 'comfortable' }
  }
  const style = record.surface === 'daemon' ? record.style : 'document'
  return {
    kind: 'markdown',
    ...head,
    mode: record.mode ?? 'light',
    ...(style === undefined ? {} : { style }),
    ...(record.fonts === undefined ? {} : { fontFamilies: record.fonts }),
    ...(record.references === true ? { references: meta.references } : {}),
    ...(record.library === true ? { tagLibrary: meta.library } : {}),
    ...(record.fragments === undefined
      ? {}
      : { fragments: record.fragments === 'full' ? meta.fragments : [] }),
    ...(record.section === undefined ? {} : { section: record.section }),
  }
}

function surface(name: string): { meta: MarkdownMeta; records: MarkdownRecord[] } {
  const [head = '', ...lines] = readFileSync(new URL(`layout-markdown.${name}.jsonl`, DIR), 'utf8')
    .trimEnd()
    .split('\n')
  return { meta: JSON.parse(head) as MarkdownMeta, records: lines.map((l) => JSON.parse(l)) }
}

const digests = new Map(
  readFileSync(new URL('layout-markdown-digests.jsonl', DIR), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { id: string; n: number; h: number })
    .map(({ id, n, h }) => [id, { n, h }] as const),
)

/** How the core's answer to `record` differs from what it is held to, if it does. */
function judged(core: Core, record: MarkdownRecord, meta: MarkdownMeta): string | undefined {
  const answer = core.layoutMarkdown(requestOf(record, meta), highlightCode)
  const differs = difference(answer, record)
  if (NAMES_A_NAME_ONLY_EMBED.has(record.id)) {
    return differs === undefined
      ? 'draws as the TypeScript did; drop it from NAMES_A_NAME_ONLY_EMBED'
      : undefined
  }
  if (!PAST_THE_PARSER.has(bodyName(record.id))) return differs
  if (!('scene' in answer)) return `not drawn as its literal text: ${JSON.stringify(answer)}`
  return differs === undefined
    ? 'draws as the TypeScript did; drop it from PAST_THE_PARSER'
    : undefined
}

/** How the core's `answer` differs from the recording of `record`, if it does. */
function difference(
  answer: ReturnType<Core['layoutMarkdown']>,
  record: MarkdownRecord,
): string | undefined {
  if ('refused' in record) return 'missing' in answer ? undefined : JSON.stringify(answer)
  if (!('scene' in answer)) return JSON.stringify(answer)
  const asked = 'asked' in record ? record.asked : undefined
  if (JSON.stringify(answer.fragmentsAsked) !== JSON.stringify(asked)) return 'asked'
  if ('scene' in record) {
    const [got, want] = [answer.scene, JSON.parse(record.scene)].map(sortedSceneDigest)
    return got?.n === want?.n && got?.h === want?.h ? undefined : 'scene'
  }
  const held = digests.get(record.id)
  const mine = sortedSceneDigest(answer.scene)
  return held?.n === mine.n && held.h === mine.h && record.n === mine.n ? undefined : 'digest'
}

describe.runIf(built)('the recorded markdown-document oracle through the core', () => {
  // Made in `beforeAll`, not in this factory: vitest runs a skipped suite's
  // factory to collect it, so a core made here fails the file where there is
  // no artifact instead of skipping it.
  let core: Core
  beforeAll(() => {
    core = coreFrom(requireWasm() as unknown as CoreGlue, wasmBytes())
  })

  for (const name of SURFACES) {
    it(`answers every ${name} record as the TypeScript did`, { timeout: 120_000 }, () => {
      const { meta, records } = surface(name)
      const parted = records
        .map((record) => [record.id, judged(core, record, meta)] as const)
        .filter(([, why]) => why !== undefined)
      expect(parted).toEqual([])
      expect(records.length).toBeGreaterThan(20)
    })
  }
})
