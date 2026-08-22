/**
 * The stage-2 measurement: what a real embedding model adds to the judged
 * search corpus, scored the same way the pinned scoreboard scores stage 0.
 *
 * Deliberately a SCRIPT and not a test. It downloads ~100MB of model weights
 * on first run and takes seconds per query — a hermetic `pnpm test` must not
 * do either. The scoreboard test stays the guard; this is the instrument
 * that decides whether there is anything worth guarding.
 *
 *   node --import tsx/esm scripts/measure/search-quality-embedding.mjs
 *
 * Prints both columns side by side, so the debt rows are read as a
 * difference rather than as an absolute nobody can calibrate.
 */
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import {
  createCanvasEditTool,
  createDocumentSearchTool,
  createDocumentSetTool,
  wbDocumentCreate,
} from '@kamiazya/whiteboard-server-core'
import { CORPUS_DOCUMENTS, JUDGED_QUERIES } from '../../../server-core/src/search/search-corpus.ts'
// Reached by path, not through the package's exports: the corpus and the
// in-memory store are test fixtures, and widening server-core's published
// surface for one local script would be the wrong trade.
import { createInMemoryDocumentStore } from '../../../server-core/src/test-utils/in-memory-document-store.ts'
import { createTransformersEmbedder } from '../../src/server/search/transformers-embedder.ts'

const WS = 'quality'
const K = 5

async function seed() {
  const deps = {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {},
    documentIndex: new InMemoryDocumentIndex(),
  }
  const set = createDocumentSetTool(deps)
  const edit = createCanvasEditTool(deps)
  for (const doc of CORPUS_DOCUMENTS) {
    const created = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: doc.path,
      kind: doc.kind,
      name: doc.name,
      createWorkspace: true,
    })
    if (doc.kind === 'markdown') {
      const frontmatter =
        doc.tags === undefined
          ? 'type: note'
          : `type: note\ntags:\n${doc.tags.map((t) => `  - ${t}`).join('\n')}`
      await set.execute({
        workspaceId: WS,
        documentId: created.documentId,
        markdown: `---\n${frontmatter}\n---\n${doc.body ?? ''}`,
      })
      continue
    }
    await edit.execute({
      workspaceId: WS,
      documentId: created.documentId,
      ops: [
        ...(doc.nodes ?? []).map((n) => ({
          op: 'node.add',
          node: { id: n.id, type: 'text', text: n.text },
        })),
        ...(doc.groups ?? []).map((g) => ({
          op: 'node.add',
          node: { id: g.id, type: 'group', label: g.label },
        })),
        ...(doc.edges ?? []).map((e) => ({
          op: 'edge.add',
          edge: { id: e.id, fromNode: e.from, toNode: e.to, label: e.label },
        })),
      ],
    })
  }
  return deps
}

async function score(search) {
  const perCategory = new Map()
  const misses = []
  for (const judged of JUDGED_QUERIES) {
    const out = await search.execute({ workspaceId: WS, query: judged.query, limit: K })
    const ranked = out.results.map((r) => r.path)
    const bucket = perCategory.get(judged.category) ?? { hits: 0, top: 0, total: 0, rrSum: 0 }
    bucket.total++
    const firstHit = ranked.findIndex((path) => judged.relevant.includes(path))
    if (firstHit === -1) misses.push(`${judged.category}: ${judged.query}`)
    else {
      bucket.hits++
      if (firstHit === 0) bucket.top++
      bucket.rrSum += 1 / (firstHit + 1)
    }
    perCategory.set(judged.category, bucket)
  }
  return { perCategory, misses }
}

const deps = await seed()

const lexical = await score(createDocumentSearchTool(deps))

const embedder = createTransformersEmbedder({
  cacheDir: new URL('../../tmp/models/', import.meta.url).pathname,
})
const startedAt = process.hrtime.bigint()
const fused = await score(createDocumentSearchTool(deps, undefined, () => embedder))
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

const CATEGORIES = ['lexical', 'bigram', 'paraphrase', 'cross-lingual']
const cell = (result, category) => {
  const b = result.perCategory.get(category)
  if (b === undefined) return '        —       '
  return `${b.top}/${b.total}  ${b.hits}/${b.total}  ${(b.rrSum / b.total).toFixed(2)}`
}

// The output IS this script's product.
const out = console.log
out('')
// hit@1 leads, because with a 6-document corpus hit@5 is nearly free —
// a random ranking would score it 5/6. The rank-1 column and MRR are the
// ones that discriminate.
out(`category         stage 0 (BM25)      stage 2 (BM25 + vectors)`)
out(`                 @1    @${K}   mrr      @1    @${K}   mrr`)
out('─'.repeat(64))
for (const category of CATEGORIES) {
  out(`${category.padEnd(15)}  ${cell(lexical, category)}     ${cell(fused, category)}`)
}
out('─'.repeat(64))
out(
  `still unanswered with vectors: ${fused.misses.length ? fused.misses.sort().join(', ') : 'none'}`,
)
out(
  `${JUDGED_QUERIES.length} queries, ${CORPUS_DOCUMENTS.length} documents, ${elapsedMs.toFixed(0)}ms including model load`,
)
out('')
