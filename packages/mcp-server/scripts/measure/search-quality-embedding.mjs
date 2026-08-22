/**
 * What an embedding model adds to search, measured on this project's own
 * documentation.
 *
 * Deliberately a SCRIPT and not a test. It needs ~113MB of model weights
 * and reads the live `docs/` tree, and `pnpm test` must be hermetic. The
 * pinned scoreboard in `search-quality.test.ts` stays the regression guard
 * over a small frozen corpus; this is the instrument that says whether one
 * ranking is BETTER than another, which that corpus is far too small to
 * answer.
 *
 *   pnpm --filter @kamiazya/whiteboard-mcp search:fetch-model   # once
 *   node --import tsx/esm scripts/measure/search-quality-embedding.mjs
 *
 * Every difference is reported with a confidence interval and a
 * significance test, never as a bare point estimate: a single mean cannot
 * distinguish a real improvement from which questions happened to be
 * asked, and reporting one alone is how a small corpus over-claims.
 */
import { InMemoryDocumentIndex } from '@kamiazya/whiteboard-ports/test-utils'
import {
  bootstrapCi,
  createDocumentSearchTool,
  createDocumentSetTool,
  ndcgAt,
  pairedPermutationTest,
  permutationFloor,
  randomBaseline,
  recallAt,
  reciprocalRank,
  requiredQueryCount,
  standardDeviation,
  wbDocumentCreate,
} from '@kamiazya/whiteboard-server-core'
import { createInMemoryDocumentStore } from '../../../server-core/src/test-utils/in-memory-document-store.ts'
import { DOCS_JUDGED_QUERIES, loadDocsCorpus } from '../../src/server/search/docs-corpus.ts'
import { searchModelCacheDir } from '../../src/server/search/search-embedder.ts'
import {
  createTransformersEmbedder,
  DEFAULT_MODEL as EMBEDDING_MODEL,
} from '../../src/server/search/transformers-embedder.ts'

const WS = 'quality'
/**
 * The reporting cutoff, 10 to match what retrieval benchmarks publish —
 * BEIR and the Japanese ones (JMTEB, JQaRA) all report nDCG@10.
 */
const K = 10
/**
 * Differences worth acting on, declared HERE rather than read off the
 * result. 0.10 is a change a reader would notice; 0.05 is about the
 * smallest anyone would tune for; 0.02 is the neighbourhood where a
 * ranking change is indistinguishable from noise.
 */
const TARGET_EFFECTS = [0.1, 0.05, 0.02]

const repoRoot = new URL('../../../../', import.meta.url).pathname
const CORPUS = loadDocsCorpus(repoRoot)

async function seed() {
  const deps = {
    documentStore: createInMemoryDocumentStore(),
    blobStore: {},
    documentIndex: new InMemoryDocumentIndex(),
  }
  const set = createDocumentSetTool(deps)
  for (const doc of CORPUS) {
    const created = await wbDocumentCreate(deps, {
      workspaceId: WS,
      path: doc.path,
      kind: 'markdown',
      name: doc.name,
      createWorkspace: true,
    })
    await set.execute({
      workspaceId: WS,
      documentId: created.documentId,
      markdown: `---\ntype: note\n---\n${doc.body}`,
    })
  }
  return deps
}

/** Per-query metric values, which is what significance testing needs. */
async function score(search) {
  const perQuery = []
  for (const judged of DOCS_JUDGED_QUERIES) {
    const out = await search.execute({ workspaceId: WS, query: judged.query, limit: K })
    const ranked = out.results.map((r) => r.path)
    perQuery.push({
      query: judged.query,
      category: judged.category,
      ndcg: ndcgAt(ranked, judged.relevant, K),
      recall: recallAt(ranked, judged.relevant, K),
      rr: reciprocalRank(ranked, judged.relevant, K),
      rank: ranked.findIndex((path) => judged.relevant[path] !== undefined) + 1,
      ranked,
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

const CATEGORIES = ['lexical', 'paraphrase', 'cross-lingual']
const METRICS = [
  [`nDCG@${K}`, 'ndcg'],
  [`recall@${K}`, 'recall'],
  ['MRR', 'rr'],
]

out('')
out(
  `corpus: ${CORPUS.length} documents from docs/, ` +
    `${DOCS_JUDGED_QUERIES.length} judged queries, cut at ${K}`,
)
if (K >= CORPUS.length) {
  out('')
  out(`  ! the cut admits the WHOLE corpus (k=${K} >= ${CORPUS.length} documents), so`)
  out('    recall@k is free and only nDCG rank-weighting discriminates.')
}

// How much of each document the model actually reads. A retrieval model
// has a fixed input length and silently truncates past it, so a corpus of
// long documents can be mostly invisible to the semantic half while every
// score still looks fine. Measured with the model's own tokenizer rather
// than estimated from characters, because the estimate is exactly the kind
// of approximation that hides a factor of four.
{
  const { AutoTokenizer, env } = await import('@huggingface/transformers')
  env.cacheDir = searchModelCacheDir()
  const tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_MODEL)
  const limit = tokenizer.model_max_length ?? 512
  let overLimit = 0
  let seen = 0
  let total = 0
  for (const doc of CORPUS) {
    const encoded = await tokenizer(`passage: ${doc.name}\n${doc.path}\n${doc.body}`)
    const length = encoded.input_ids.dims[1]
    total += length
    seen += Math.min(length, limit)
    if (length > limit) overLimit++
  }
  out('')
  out(`what the model READS: input limit ${limit} tokens`)
  out('-'.repeat(64))
  out(
    `  ${overLimit}/${CORPUS.length} documents are truncated; ` +
      `the model sees ${((seen / total) * 100).toFixed(0)}% of the corpus text ` +
      `(mean ${Math.round(total / CORPUS.length)} tokens per document)`,
  )
  if (overLimit > 0) {
    out('  every score below is achieved WITHOUT the truncated remainder.')
  }
}

out('')
out('by category                stage 0    stage 2     random')
out('-'.repeat(64))
for (const [label, metric] of METRICS) {
  out(label)
  for (const category of CATEGORIES) {
    const rows = DOCS_JUDGED_QUERIES.filter((q) => q.category === category)
    if (rows.length === 0) continue
    const floor = randomBaseline({
      corpusSize: CORPUS.length,
      relevantCount: Math.round(mean(rows.map((q) => Object.keys(q.relevant).length))),
      k: K,
    })
    const floorValue =
      metric === 'ndcg' ? floor.ndcg : metric === 'recall' ? floor.recall : floor.mrr
    out(
      `  ${(`${category} (${rows.length})`).padEnd(22)} ` +
        `${mean(pick(lexical, metric, category))
          .toFixed(3)
          .padStart(6)}   ` +
        `${mean(pick(fused, metric, category))
          .toFixed(3)
          .padStart(6)}     ` +
        `${floorValue.toFixed(3)}`,
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
  const sign = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`
  out(
    `${label.padEnd(10)} ${mean(before).toFixed(3)} -> ${mean(after).toFixed(3)}  ` +
      `delta ${sign(test.observed)} [${sign(ci.low)}, ${sign(ci.high)}] ` +
      `p=${test.p.toFixed(4)} (floor ${floor.toExponential(1)})`,
  )
  // Sample sizes for differences chosen in advance as worth acting on, NOT
  // for the difference just observed — that would be post-hoc power, which
  // only ever restates the p-value.
  const needed = TARGET_EFFECTS.map(
    (minDetectable) =>
      `${minDetectable.toFixed(2)}:${requiredQueryCount({ sd, minDetectable }) ?? 'n/a'}`,
  ).join('  ')
  out(`           per-query sd ${sd.toFixed(3)};  queries needed for a delta of  ${needed}`)
}

out('')
out('queries where the two systems disagree most')
out('-'.repeat(64))
const disagreements = lexical
  .map((a, i) => ({ a, b: fused[i], delta: fused[i].ndcg - a.ndcg }))
  .filter((row) => Math.abs(row.delta) > 0.01)
  .sort((x, y) => x.delta - y.delta)
for (const row of [...disagreements.slice(0, 5), ...disagreements.slice(-5)]) {
  out(
    `  ${row.delta >= 0 ? '+' : ''}${row.delta.toFixed(2)}  rank ${row.a.rank} -> ${row.b.rank}  ` +
      `${row.a.category.padEnd(14)} ${row.a.query}`,
  )
}

// The pool: documents both systems rank highly that nobody has judged.
// Unjudged counts as irrelevant, which penalises a system for returning
// something genuinely useful — so this list is where the next round of
// judgements comes from, and reading it is how the collection grows.
out('')
out('unjudged documents ranked in the top 3 by either system')
out('-'.repeat(64))
const pool = new Map()
for (let i = 0; i < lexical.length; i++) {
  const judged = DOCS_JUDGED_QUERIES[i]
  for (const row of [lexical[i], fused[i]]) {
    for (const path of row.ranked.slice(0, 3)) {
      if (judged.relevant[path] !== undefined) continue
      const key = `${judged.query} -> ${path}`
      pool.set(key, (pool.get(key) ?? 0) + 1)
    }
  }
}
if (pool.size === 0) out('  (none — judgements cover every top-3 result)')
else {
  for (const key of [...pool.keys()].slice(0, 15)) out(`  ${key}`)
  if (pool.size > 15) out(`  ... and ${pool.size - 15} more`)
}

out('')
out(`${elapsedMs.toFixed(0)}ms for the stage-2 pass including model load`)
out('')
