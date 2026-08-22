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
 * Reports each metric as a difference with a confidence interval and a
 * significance test, never as a bare point estimate. A single mean cannot
 * distinguish a real improvement from which twelve questions happened to
 * be asked, and reporting one alone is how a small corpus over-claims.
 */
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import {
  createCanvasEditTool,
  createDocumentSearchTool,
  createDocumentSetTool,
  wbDocumentCreate,
} from '@kamiazya/whiteboard-server-core'
import {
  bootstrapCi,
  ndcgAt,
  pairedPermutationTest,
  permutationFloor,
  randomBaseline,
  recallAt,
  reciprocalRank,
  requiredQueryCount,
  standardDeviation,
} from '../../../server-core/src/search/eval.ts'
import { CORPUS_DOCUMENTS, JUDGED_QUERIES } from '../../../server-core/src/search/search-corpus.ts'
// Reached by path, not through the package's exports: the corpus and the
// in-memory store are test fixtures, and widening server-core's published
// surface for one local script would be the wrong trade.
import { createInMemoryDocumentStore } from '../../../server-core/src/test-utils/in-memory-document-store.ts'
import { searchModelCacheDir } from '../../src/server/search/search-embedder.ts'
import { createTransformersEmbedder } from '../../src/server/search/transformers-embedder.ts'

const WS = 'quality'
const K = 10

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

/** Per-query metric values, which is what significance testing needs. */
async function score(search) {
  const perQuery = []
  for (const judged of JUDGED_QUERIES) {
    const out = await search.execute({ workspaceId: WS, query: judged.query, limit: K })
    const ranked = out.results.map((r) => r.path)
    perQuery.push({
      query: judged.query,
      category: judged.category,
      ndcg: ndcgAt(ranked, judged.relevant, K),
      recall: recallAt(ranked, judged.relevant, K),
      rr: reciprocalRank(ranked, judged.relevant, K),
      rank: ranked.findIndex((path) => judged.relevant[path] !== undefined) + 1,
    })
  }
  return perQuery
}

const deps = await seed()

const lexical = await score(createDocumentSearchTool(deps))

const embedder = createTransformersEmbedder({ cacheDir: searchModelCacheDir() })

// Preflight, and it is not ceremony. A model that is missing, gated, or
// broken makes `embed` return nothing and the search tool fall back to
// lexical results — silently and by design, because a user's search must
// not fail over it. In a MEASUREMENT that same fallback prints a stage-2
// column identical to stage 0 and calls it a result. It happened on the
// first run of this script, against a gated model id.
const [probe] = await embedder.embed(['preflight'], 'document')
if (probe === undefined || probe.length !== embedder.dimensions) {
  process.stderr.write(
    'the embedding model did not load — refusing to print a stage-2 column ' +
      'that would just be stage 0 under another heading.\n' +
      'run: pnpm --filter @kamiazya/whiteboard-mcp search:fetch-model\n',
  )
  process.exit(1)
}

const startedAt = process.hrtime.bigint()
const fused = await score(createDocumentSearchTool({ ...deps, embedder }))
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

// The output IS this script's product.
const out = console.log
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const pick = (rows, metric, category) =>
  rows.filter((r) => category === undefined || r.category === category).map((r) => r[metric])

const CATEGORIES = ['lexical', 'bigram', 'paraphrase', 'cross-lingual']
/**
 * Differences worth acting on, declared here rather than read off the
 * result. 0.10 is a change a reader would notice; 0.05 is about the
 * smallest anyone would tune for; 0.02 is the neighbourhood where a
 * ranking change is indistinguishable from noise without a real corpus.
 */
const TARGET_EFFECTS = [0.1, 0.05, 0.02]
const METRICS = [
  [`nDCG@${K}`, 'ndcg'],
  [`recall@${K}`, 'recall'],
  ['MRR', 'rr'],
]

out('')
out(`corpus: ${CORPUS_DOCUMENTS.length} documents, ${JUDGED_QUERIES.length} queries, cut at ${K}`)
if (K >= CORPUS_DOCUMENTS.length) {
  out('')
  out(`  ! the cut admits the WHOLE corpus (k=${K} >= ${CORPUS_DOCUMENTS.length} documents), so`)
  out('    recall@k is free and only nDCG rank-weighting discriminates. Read')
  out('    every number below against the random floor, not against 1.0.')
}

out('')
out('by category                stage 0    stage 2     random')
out('-'.repeat(64))
for (const [label, metric] of METRICS) {
  out(label)
  for (const category of CATEGORIES) {
    const a = mean(pick(lexical, metric, category))
    const b = mean(pick(fused, metric, category))
    const relevantCounts = JUDGED_QUERIES.filter((q) => q.category === category).map(
      (q) => Object.keys(q.relevant).length,
    )
    const floor = randomBaseline({
      corpusSize: CORPUS_DOCUMENTS.length,
      relevantCount: Math.round(mean(relevantCounts)),
      k: K,
    })
    const floorValue =
      metric === 'ndcg' ? floor.ndcg : metric === 'recall' ? floor.recall : floor.mrr
    out(
      `  ${category.padEnd(22)} ${a.toFixed(3).padStart(6)}   ${b.toFixed(3).padStart(6)}` +
        `     ${floorValue.toFixed(3)}`,
    )
  }
}

out('')
out('overall, with the difference tested rather than asserted')
out('-'.repeat(64))
for (const [label, metric] of METRICS) {
  const before = pick(lexical, metric)
  const after = pick(fused, metric)
  const deltas = after.map((v, i) => v - before[i])
  const ci = bootstrapCi(deltas)
  const test = pairedPermutationTest(deltas)
  const floor = permutationFloor(deltas)
  const sd = standardDeviation(deltas)
  out(
    `${label.padEnd(10)} ${mean(before).toFixed(3)} -> ${mean(after).toFixed(3)}  ` +
      `delta ${test.observed >= 0 ? '+' : ''}${test.observed.toFixed(3)} ` +
      `[${ci.low >= 0 ? '+' : ''}${ci.low.toFixed(3)}, ${ci.high >= 0 ? '+' : ''}${ci.high.toFixed(3)}] ` +
      `p=${test.p.toFixed(4)} (floor ${floor.toFixed(4)})`,
  )
  // Sample sizes for differences chosen in advance as worth acting on,
  // NOT for the difference just observed — that would be post-hoc power,
  // which only ever restates the p-value.
  const needed = TARGET_EFFECTS.map((minDetectable) => {
    const n = requiredQueryCount({ sd, minDetectable })
    return `${minDetectable.toFixed(2)}:${n ?? 'n/a'}`
  }).join('  ')
  out(`           per-query sd ${sd.toFixed(3)};  queries needed for a delta of  ${needed}`)
}

out('')
out('per-query rank of the first relevant document (0 = not returned)')
out('-'.repeat(64))
for (let i = 0; i < lexical.length; i++) {
  const a = lexical[i]
  const b = fused[i]
  out(
    `  ${String(a.rank).padStart(2)} -> ${String(b.rank).padStart(2)}   ` +
      `${a.category.padEnd(14)} ${a.query}`,
  )
}
out('')
out(`${elapsedMs.toFixed(0)}ms for the stage-2 pass including model load`)
out('')
