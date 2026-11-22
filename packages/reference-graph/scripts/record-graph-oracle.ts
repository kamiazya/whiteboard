// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: a recorder lists a corpus case by case; its branches are cases, not logic
/**
 * Records `src/oracle/graph-rules.jsonl`: what this package's pure judgements
 * answer today — the facts a document contributes (references, searchable
 * texts, tag bearers), where a name is mentioned outside a link, the edit that
 * links those mentions, the edit that follows a rename, and the backlinks and
 * unlinked mentions a listing and its facts answer. Each row is the input and
 * the answer, or the class of the refusal.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp exec tsx \
 *     ../reference-graph/scripts/record-graph-oracle.ts
 *
 * Every random choice comes from a seeded generator, and prose is drawn from the
 * recorded reference-scanner corpus in codec, so a re-run under the same cores
 * writes the same file. The recording is the oracle for the Rust
 * `whiteboard-reference-graph` crate: re-take it only deliberately.
 */
import '../../codec/src/test-utils/core-setup/node.setup.js'
import '../../search/src/test-utils/core-setup/node.setup.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanReferences } from '@kamiazya/whiteboard-codec'
import type { ContentWithTags, DocumentContent } from '@kamiazya/whiteboard-loro-adapter'
import {
  MARKDOWN_MAX_CHARS,
  NODE_TEXT_MAX_CHARS,
  type SpatialCanvas,
  type SpatialNode,
} from '@kamiazya/whiteboard-model'
import { fileNode, groupNode, textNode } from '@kamiazya/whiteboard-model/test-utils'
import { extractContentFacts } from '../src/extract.js'
import { type GraphRow, replay } from '../src/test-utils/graph-oracle.js'

const here = dirname(fileURLToPath(import.meta.url))
const OUT = join(here, '..', 'src', 'oracle', 'graph-rules.jsonl')
const SCAN = join(here, '..', '..', 'codec', 'src', 'references', 'oracle', 'scan.jsonl')

type Rng = () => number
function rngOf(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const docId = (n: number) =>
  `01ARZ3NDEKTSV4RRFFQ69G5F${CROCKFORD[(n >> 5) & 31]}${CROCKFORD[n & 31]}`.slice(0, 26)

const rows: Array<Record<string, unknown>> = []
function record(tag: string, row: GraphRow) {
  rows.push({ id: `${row.op}-${rows.length}`, tag, ...row, result: replay(row) })
}

// ---- the corpus: names and prose ----

/** Names a person gives a document: CJK, emoji, a ZWJ family, brackets, pipes, case variants. */
const NAMES = [
  'Plan',
  'plan',
  '日本語',
  '😀',
  '👩‍👩‍👧',
  'Résumé',
  'Arrays [0]',
  'a|b',
  'Notes',
  'Q3 plan',
  'x',
  'a#b',
]
const PATHS = ['plan', 'notes', 'a/b', 'a/b/c', 'archive/old', 'x-1', 'draft']
const HEADINGS = ['Intro', '日本語', 'a b', 'x#y']
const FILLER = ['see', 'the', 'and then', 'also', '—', 'review', 'Friday', '👍', 'é']

/** Bodies the reference scanner's recorded corpus holds, evenly spaced, short enough to repeat per reference. */
const corpus = readFileSync(SCAN, 'utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line) as { t?: string; r?: unknown[] })
  .filter((c) => typeof c.t === 'string' && c.t.length >= 3 && c.t.length <= 160)
const scanned = Array.from(
  { length: 110 },
  (_, i) => corpus[Math.floor((i * corpus.length) / 110)]?.t as string,
)

function prose(rng: Rng, parts: number, inject: string[]): string {
  const pieces = Array.from({ length: parts }, () => pick(rng, FILLER))
  for (const item of inject) pieces.splice(int(rng, 0, pieces.length), 0, item)
  return pieces.join(' ')
}

/** A reference written as a person writes one: by path or id, aliased, to a heading, embedded. */
function link(rng: Rng, targets: Array<{ id: string; path: string }>): string {
  const t = pick(rng, targets)
  const ref = rng() < 0.3 ? t.id : t.path
  const heading = rng() < 0.25 ? `#${pick(rng, HEADINGS)}` : ''
  const alias = rng() < 0.35 ? `|${pick(rng, NAMES)}` : ''
  return `${rng() < 0.15 ? '!' : ''}[[${ref}${heading}${alias}]]`
}

// ---- extraction ----

function canvasOf(nodes: SpatialNode[], edges: SpatialCanvas['edges'] = []): SpatialCanvas {
  return { nodes, edges }
}

const box = (id: string, y: number) => ({ id, x: 0, y, width: 100, height: 40 })

function spatialSamples(rng: Rng): Array<{ tag: string; canvas: SpatialCanvas }> {
  const targets = PATHS.map((path, i) => ({ id: docId(i + 1), path }))
  const out: Array<{ tag: string; canvas: SpatialCanvas }> = []
  out.push({ tag: 'empty', canvas: canvasOf([]) })
  out.push({
    tag: 'embed-and-file',
    canvas: canvasOf([
      textNode({ ...box('n1', 0), text: 'plain', embed: { documentId: docId(3) } }),
      fileNode({ ...box('n2', 50), file: 'a/b' }),
      fileNode({ ...box('n3', 100), file: 'notes', subpath: 'sec' }),
      groupNode({ ...box('n4', 150), label: '日本語', tags: ['g'] }),
    ]),
  })
  for (let i = 0; i < 12; i++) {
    const nodes: SpatialNode[] = []
    const count = int(rng, 1, 5)
    for (let k = 0; k < count; k++) {
      const text = prose(rng, int(rng, 0, 3), rng() < 0.7 ? [link(rng, targets)] : [])
      const tags = rng() < 0.4 ? [pick(rng, ['todo', 'a/b', '日本語', 'x'])] : undefined
      nodes.push(
        rng() < 0.2
          ? groupNode({
              ...box(`n${k}`, k * 50),
              label: pick(rng, NAMES),
              ...(tags ? { tags } : {}),
            })
          : textNode({ ...box(`n${k}`, k * 50), text, ...(tags ? { tags } : {}) }),
      )
    }
    const edges: SpatialCanvas['edges'] =
      count > 1
        ? [
            {
              id: 'e1',
              from: { node: 'n0' },
              to: { node: 'n1' },
              ...(rng() < 0.5 ? { label: pick(rng, NAMES) } : {}),
              ...(rng() < 0.6 ? { tags: ['rel'] } : {}),
            },
          ]
        : []
    out.push({
      tag: `generated-${i}`,
      canvas: {
        ...canvasOf(nodes, edges),
        ...(rng() < 0.3 ? { tags: ['board', pick(rng, ['日本語', 'x'])] } : {}),
      },
    })
  }
  return out
}

function recordExtraction() {
  const rng = rngOf(11)
  const targets = PATHS.map((path, i) => ({ id: docId(i + 1), path }))
  const markdown: ContentWithTags[] = []
  for (const body of scanned) markdown.push({ content: { kind: 'markdown', body } })
  for (let i = 0; i < 30; i++) {
    const body = prose(
      rng,
      int(rng, 1, 6),
      Array.from({ length: int(rng, 0, 4) }, () => link(rng, targets)),
    )
    const tags = rng() < 0.4 ? [pick(rng, ['todo', 'a/b', '日本語'])] : undefined
    markdown.push({ content: { kind: 'markdown', body }, ...(tags ? { tags } : {}) })
  }
  markdown.push({ content: { kind: 'markdown', body: '' }, tags: [] })
  for (const loaded of markdown) record('markdown', { op: 'extractContentFacts', loaded })
  for (const loaded of markdown.slice(-14)) record('markdown', { op: 'tagBearersOf', loaded })

  for (const { tag, canvas } of spatialSamples(rngOf(12))) {
    const loaded: ContentWithTags = { content: { kind: 'spatial', canvas } }
    record(tag, { op: 'extractContentFacts', loaded })
    record(tag, { op: 'tagBearersOf', loaded })
  }

  const bearer = (what: string, ...tags: string[]) => ({ what, tags })
  const cases: Array<[string, Array<{ what: string; tags: string[] }>]> = [
    ['none', []],
    ['document', [bearer('document', 'a', 'b')]],
    ['board', [bearer('board', 'a')]],
    ['carried', [bearer('node', 'x', 'y'), bearer('edge', 'y', 'z')]],
    ['own-and-carried', [bearer('document', 'a'), bearer('node', 'x'), bearer('node', 'x')]],
    ['first-own-wins', [bearer('board', 'one'), bearer('document', 'two')]],
    ['unknown-kind', [bearer('other', 'q')]],
  ]
  for (const [tag, bearers] of cases) record(tag, { op: 'splitBearerTags', bearers })
}

// ---- mentions and the edits that link them ----

function recordMentionsAndLinking() {
  const rng = rngOf(21)
  const texts = [
    '',
    'Plan',
    'Plan Plan Plan',
    '[[Plan]]Plan',
    '[[Plan|Plan]] and Plan',
    '![[Plan]] then Plan',
    '[[ Plan ]] Plan',
    '[[Plan',
    'Plan]] Plan',
    'PlanPlan plan',
    '日本語の日本語',
    '😀 😀😀',
    '👩‍👩‍👧 and 👩‍👩‍👧',
    'Arrays [0] and [[Arrays [0]]]',
    'a|b in [[x|a|b]] and a|b',
    'a#b [[a#b]] a#b',
    '[[a]] a [[b]] a [[c|a]] a',
  ]
  for (const text of texts) {
    for (const name of ['Plan', '日本語', '😀', '👩‍👩‍👧', 'Arrays [0]', 'a|b', 'a#b', 'a']) {
      if (text.includes(name) || name === 'Plan')
        record('fixed', { op: 'unlinkedNameSpans', text, name })
    }
  }
  for (let i = 0; i < 40; i++) {
    const name = pick(rng, NAMES)
    const text = prose(rng, int(rng, 1, 5), [
      name,
      ...(rng() < 0.6 ? [`[[${pick(rng, PATHS)}|${name}]]`] : []),
      ...(rng() < 0.5 ? [name] : []),
    ])
    record('generated', { op: 'unlinkedNameSpans', text, name })
  }

  const target = (name: string, path = 'plan') => ({ documentId: docId(1), path, name })
  // the markup written for each kind of name and path is what a linked mention inserts
  for (const name of NAMES) {
    for (const path of ['plan', 'a/b/c']) {
      record('markup', {
        op: 'planLinkifyMentions',
        content: { kind: 'markdown', body: name },
        target: target(name, path),
      })
    }
  }
  record('markup-long-name', {
    op: 'planLinkifyMentions',
    content: { kind: 'markdown', body: 'n'.repeat(120) },
    target: target('n'.repeat(120), 'a/b'),
  })

  const bodies = [...texts, ...scanned.slice(0, 20)]
  for (const body of bodies) {
    for (const name of ['Plan', '日本語']) {
      record('body', {
        op: 'planLinkifyMentions',
        content: { kind: 'markdown', body },
        target: target(name),
      })
    }
  }
  for (let i = 0; i < 30; i++) {
    const name = pick(rng, NAMES)
    const body = prose(rng, int(rng, 1, 6), [
      name,
      name,
      `[[${name}]]`,
      link(rng, [{ id: docId(2), path: 'notes' }]),
    ])
    record('generated-body', {
      op: 'planLinkifyMentions',
      content: { kind: 'markdown', body },
      target: target(name, pick(rng, PATHS)),
    })
  }

  const canvases = spatialSamples(rngOf(22))
  for (const { tag, canvas } of canvases) {
    for (const name of ['plan', '日本語', 'x']) {
      record(tag, {
        op: 'planLinkifyMentions',
        content: { kind: 'spatial', canvas },
        target: target(name),
      })
    }
  }
  const mentioning = (text: string, id = 'n1'): DocumentContent => ({
    kind: 'spatial',
    canvas: canvasOf([
      textNode({ ...box(id, 0), text }),
      groupNode({ ...box('g', 60), label: 'Plan' }),
    ]),
  })
  record('text-node-and-label', {
    op: 'planLinkifyMentions',
    content: mentioning('Plan and [[Plan]] and Plan'),
    target: target('Plan'),
  })

  // growth past the ceilings: refused whole, before any edit exists
  const bodyFor = (count: number) => 'x '.repeat(count)
  record('body-over-ceiling', {
    op: 'planLinkifyMentions',
    content: { kind: 'markdown', body: bodyFor(MARKDOWN_MAX_CHARS / 4) },
    target: target('x', 'p'),
  })
  record('body-under-ceiling', {
    op: 'planLinkifyMentions',
    content: { kind: 'markdown', body: bodyFor(200) },
    target: target('x', 'p'),
  })
  // the ceiling to the character: a body or node text linking to exactly it is kept, one past it is refused
  const probe = replay({
    op: 'planLinkifyMentions',
    content: { kind: 'markdown', body: 'x' },
    target: target('x', 'p'),
  }).ok as { edit: { runs: Array<{ insert: string }> } }
  const markupGrowth = (probe.edit.runs[0]?.insert.length ?? 0) - 1
  const exactly = (max: number, past: number) => {
    const length = max + past - markupGrowth
    return `x${'y'.repeat(length - 1)}`
  }
  for (const past of [0, 1]) {
    record(`body-ceiling-plus-${past}`, {
      op: 'planLinkifyMentions',
      content: { kind: 'markdown', body: exactly(MARKDOWN_MAX_CHARS, past) },
      target: target('x', 'p'),
    })
    record(`node-text-ceiling-plus-${past}`, {
      op: 'planLinkifyMentions',
      content: mentioning(exactly(NODE_TEXT_MAX_CHARS, past)),
      target: target('x', 'p'),
    })
  }
  for (const fill of [NODE_TEXT_MAX_CHARS / 2, NODE_TEXT_MAX_CHARS / 8, 10]) {
    record(`node-text-${fill}`, {
      op: 'planLinkifyMentions',
      content: mentioning('x '.repeat(fill)),
      target: target('x', 'p'),
    })
  }
}

// ---- rewrites on rename ----

function recordRewrites() {
  const rng = rngOf(31)
  const plans: Array<[string, Array<[string, string]>]> = [
    ['rename', [['plan', 'plans']]],
    ['move-deeper', [['plan', 'archive/old/plan']]],
    ['to-id', [['plan', docId(9)]]],
    [
      'two',
      [
        ['plan', 'p2'],
        ['notes', 'n2'],
      ],
    ],
    ['unrelated', [['nothing', 'else']]],
    ['empty', []],
    ['cjk', [['a/b', '日本語/b']]],
    [
      'swap',
      [
        ['plan', 'notes'],
        ['notes', 'plan'],
      ],
    ],
  ]
  const bodies = [
    '[[plan]]',
    '![[plan|Alias]] and [[plan#Intro]]',
    '[[notes]] [[plan]] [[a/b/c|C]]',
    '[[plan#Intro|日本語]]',
    'no references',
    '[[ plan ]] [[plan ]]',
    '[[PLAN]] [[plan]]',
    '[[a/b#日本語]]',
    ...scanned.slice(0, 6),
  ]
  for (const [tag, plan] of plans) {
    for (const body of bodies) {
      record(tag, { op: 'planDocumentReferenceRewrite', content: { kind: 'markdown', body }, plan })
    }
  }
  // the recorded scanner corpus, each body repointed at its own first reference
  for (const body of scanned) {
    const first = scanReferences(body)[0]
    if (first === undefined) continue
    record('scanned-first', {
      op: 'planDocumentReferenceRewrite',
      content: { kind: 'markdown', body },
      plan: [[first.target, 'moved/here']],
    })
  }
  const targets = PATHS.map((path, i) => ({ id: docId(i + 1), path }))
  for (let i = 0; i < 24; i++) {
    const body = prose(
      rng,
      int(rng, 1, 5),
      Array.from({ length: int(rng, 1, 4) }, () => link(rng, targets)),
    )
    record('generated', {
      op: 'planDocumentReferenceRewrite',
      content: { kind: 'markdown', body },
      plan: [[pick(rng, PATHS), pick(rng, ['plans', 'archive/old/p', docId(7), '日本語'])]],
    })
  }
  for (const { tag, canvas } of spatialSamples(rngOf(32))) {
    for (const [planTag, plan] of plans.slice(0, 4)) {
      record(`${tag}-${planTag}`, {
        op: 'planDocumentReferenceRewrite',
        content: { kind: 'spatial', canvas },
        plan,
      })
    }
  }
  const dense = (n: number): DocumentContent => ({
    kind: 'spatial',
    canvas: canvasOf([textNode({ ...box('n1', 0), text: '[[a]]'.repeat(n) })]),
  })
  const longPath = `${'seg/'.repeat(20)}end`
  for (const n of [10, 1000, 1400]) {
    record(`node-text-${n}`, {
      op: 'planDocumentReferenceRewrite',
      content: dense(n),
      plan: [['a', longPath]],
    })
  }
  record('body-over-ceiling', {
    op: 'planDocumentReferenceRewrite',
    content: { kind: 'markdown', body: '[[a]]'.repeat(MARKDOWN_MAX_CHARS / 8) },
    plan: [['a', longPath]],
  })
  // text already past the node ceiling that a rewrite only shortens is not a growth
  record('node-text-over-and-shrinking', {
    op: 'planDocumentReferenceRewrite',
    content: {
      kind: 'spatial',
      canvas: canvasOf([textNode({ ...box('n1', 0), text: '[[abcdefghij]]'.repeat(700) })]),
    },
    plan: [['abcdefghij', 'abcdefghi']],
  })
  record('body-shrinks', {
    op: 'planDocumentReferenceRewrite',
    content: { kind: 'markdown', body: '[[archive/old/plan]]'.repeat(50) },
    plan: [['archive/old/plan', 'p']],
  })
}

// ---- backlinks and unlinked mentions over a listing ----

function recordBacklinks() {
  for (let s = 0; s < 14; s++) {
    const rng = rngOf(41 + s)
    const count = int(rng, 3, 6)
    const docs = Array.from({ length: count }, (_, i) => ({
      id: docId(100 + s * 8 + i),
      // a shared path now and then: two documents the reader cannot tell apart
      path: s % 5 === 4 && i === 1 ? PATHS[0] : (PATHS[i] as string),
      name: rng() < 0.75 ? pick(rng, NAMES) : undefined,
      kind: rng() < 0.3 ? ('spatial' as const) : ('markdown' as const),
    }))
    const targets = docs.map((d) => ({ id: d.id, path: d.path }))
    const names = docs.flatMap((d) => (d.name === undefined ? [] : [d.name]))
    const entries = docs.map((d) => ({
      documentId: d.id,
      path: d.path,
      ...(d.name === undefined ? {} : { name: d.name }),
      kind: d.kind,
    }))
    const facts = docs.map((d): [string, { refs: unknown; texts: unknown }] => {
      const inject = [
        ...Array.from({ length: int(rng, 0, 4) }, () => link(rng, targets)),
        ...Array.from({ length: int(rng, 0, 4) }, () =>
          names.length > 0 ? pick(rng, names) : 'x',
        ),
      ]
      const loaded: ContentWithTags =
        d.kind === 'markdown'
          ? { content: { kind: 'markdown', body: prose(rng, int(rng, 2, 8), inject) } }
          : {
              content: {
                kind: 'spatial',
                canvas: canvasOf([
                  textNode({ ...box('n1', 0), text: prose(rng, 2, inject.slice(0, 3)) }),
                  textNode({
                    ...box('n2', 60),
                    text: 'embeds',
                    embed: { documentId: pick(rng, targets).id },
                  }),
                  fileNode({ ...box('n3', 120), file: pick(rng, targets).path }),
                ]),
              },
            }
      const { refs, texts } = extractContentFacts(loaded)
      return [d.id, { refs, texts }]
    })
    for (const d of docs) {
      record(`scene-${s}`, {
        op: 'backlinksIn',
        entries: entries as never,
        facts: facts as never,
        documentId: d.id,
      })
    }
  }
  // a path that spells another document's id: `[[id]]` names that document and never the one at the path
  const spelled = docId(3)
  record('path-spells-an-id', {
    op: 'backlinksIn',
    entries: [
      { documentId: docId(1), path: spelled, kind: 'markdown' },
      { documentId: docId(2), path: 'notes', kind: 'markdown' },
      { documentId: spelled, path: 'other', kind: 'markdown' },
    ] as never,
    facts: [
      [
        docId(2),
        {
          refs: [
            {
              target: spelled,
              via: 'wikilink',
              byId: true,
              text: `[[${spelled}]]`,
              index: 0,
              length: 30,
            },
          ],
          texts: [],
        },
      ],
    ] as never,
    documentId: docId(1),
  })
  record('path-spells-an-id-other', {
    op: 'backlinksIn',
    entries: [
      { documentId: docId(1), path: spelled, kind: 'markdown' },
      { documentId: docId(2), path: 'notes', kind: 'markdown' },
      { documentId: spelled, path: 'other', kind: 'markdown' },
    ] as never,
    facts: [
      [
        docId(2),
        {
          refs: [
            {
              target: spelled,
              via: 'wikilink',
              byId: true,
              text: `[[${spelled}]]`,
              index: 0,
              length: 30,
            },
          ],
          texts: [],
        },
      ],
    ] as never,
    documentId: spelled,
  })
  const only = [{ documentId: docId(1), path: 'plan', name: 'Plan', kind: 'markdown' as const }]
  record('absent-target', {
    op: 'backlinksIn',
    entries: only as never,
    facts: [],
    documentId: docId(5),
  })
  record('no-facts', { op: 'backlinksIn', entries: only as never, facts: [], documentId: docId(1) })
  // many mentions in one source: only the first three are quoted
  const mentioning = Array.from({ length: 6 }, (_, i) => `Plan ${i}`)
  record('many-contexts', {
    op: 'backlinksIn',
    entries: [
      ...only,
      { documentId: docId(2), path: 'notes', name: 'Notes', kind: 'markdown' as const },
    ] as never,
    facts: [[docId(2), { refs: [], texts: mentioning }]],
    documentId: docId(1),
  })
}

// ---- the refusal's own wording ----

function recordBreaches() {
  for (const chars of [1, MARKDOWN_MAX_CHARS + 1, 5_000_000]) {
    record('body', { op: 'breachMessage', breach: { shape: 'body', chars } })
  }
  for (const [chars, nodeId] of [
    [NODE_TEXT_MAX_CHARS + 1, 'n1'],
    [9000, 'a "quoted" id'],
    [9000, '日本語'],
  ] as const) {
    record('node-text', { op: 'breachMessage', breach: { shape: 'node-text', chars, nodeId } })
  }
}

recordExtraction()
recordMentionsAndLinking()
recordRewrites()
recordBacklinks()
recordBreaches()

const body = `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`
writeFileSync(OUT, body)
console.log(`wrote ${rows.length} rows, ${body.length} bytes to ${OUT}`)
