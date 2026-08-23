/**
 * SPIKE — prices chunking before anyone builds it.
 *
 * The instrument reported that 37 of 45 documents exceed the model's
 * 512-token input, so the embedder reads about a fifth of the corpus text.
 * Chunking is the obvious answer and it is not a small change: the port
 * becomes multi-vector, the cache stores a vector per passage, and the
 * ranking max-pools. Worth knowing what it buys first.
 *
 * Isolates the SEMANTIC half deliberately. Fusion would dilute the effect
 * and require the production change this spike exists to avoid; whatever
 * the vector ranking gains here, fusion inherits most of.
 *
 *   node --import tsx/esm scripts/measure/chunking-spike.mjs
 */
import { fileURLToPath } from 'node:url'
import {
  bootstrapCi,
  ndcgAt,
  pairedPermutationTest,
  permutationFloor,
  recallAt,
  reciprocalRank,
  requiredQueryCount,
  standardDeviation,
} from '@kamiazya/whiteboard-server-core'
import { DOCS_JUDGED_QUERIES, loadDocsCorpus } from '../../src/server/search/docs-corpus.ts'
import { searchModelCacheDir } from '../../src/server/search/search-embedder.ts'
import { DEFAULT_MODEL } from '../../src/server/search/transformers-embedder.ts'

const K = 10
/** Leaves room for the `passage: ` prefix and the special tokens. */
const CHUNK_BUDGET = 480

const CORPUS = loadDocsCorpus(fileURLToPath(new URL('../../../../', import.meta.url)))

const { AutoTokenizer, env, pipeline } = await import('@huggingface/transformers')
env.cacheDir = searchModelCacheDir()
const tokenizer = await AutoTokenizer.from_pretrained(DEFAULT_MODEL)
const extractor = await pipeline('feature-extraction', DEFAULT_MODEL, { dtype: 'q8' })

const countTokens = async (text) => (await tokenizer(text)).input_ids.dims[1]

/**
 * Greedy packing over markdown BLOCKS rather than a blind character window.
 * A heading and the paragraph under it belong together, and splitting mid
 * sentence is what makes a passage embedding meaningless.
 */
async function chunk(text) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim() !== '')
  const chunks = []
  let current = ''
  for (const block of blocks) {
    const candidate = current === '' ? block : `${current}\n\n${block}`
    if ((await countTokens(candidate)) <= CHUNK_BUDGET) {
      current = candidate
      continue
    }
    if (current !== '') chunks.push(current)
    // A single block over budget is cut by lines; nothing smaller is safe
    // to assume about arbitrary markdown.
    if ((await countTokens(block)) > CHUNK_BUDGET) {
      let part = ''
      for (const line of block.split('\n')) {
        const next = part === '' ? line : `${part}\n${line}`
        if ((await countTokens(next)) > CHUNK_BUDGET) {
          if (part !== '') chunks.push(part)
          part = line
        } else part = next
      }
      current = part
    } else current = block
  }
  if (current.trim() !== '') chunks.push(current)
  return chunks.length === 0 ? [text] : chunks
}

const embed = async (texts, role) => {
  const prefix = role === 'query' ? 'query: ' : 'passage: '
  const out = await extractor(
    texts.map((t) => `${prefix}${t}`),
    { pooling: 'mean', normalize: true },
  )
  const width = out.data.length / texts.length
  return texts.map((_, i) => Float32Array.from(out.data.slice(i * width, (i + 1) * width)))
}

const cosine = (a, b) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

process.stdout.write(`chunking ${CORPUS.length} documents at <=${CHUNK_BUDGET} tokens...\n`)
const perDocument = []
for (const doc of CORPUS) {
  const text = `${doc.name}\n${doc.path}\n${doc.body}`
  const pieces = await chunk(text)
  perDocument.push({ path: doc.path, whole: text, pieces })
}
const chunkCount = perDocument.reduce((n, d) => n + d.pieces.length, 0)
process.stdout.write(
  `  ${chunkCount} chunks, ${(chunkCount / CORPUS.length).toFixed(1)} per document ` +
    `(max ${Math.max(...perDocument.map((d) => d.pieces.length))})\n`,
)

process.stdout.write('embedding (truncated baseline)...\n')
const wholeVectors = await embed(
  perDocument.map((d) => d.whole),
  'document',
)
process.stdout.write('embedding (chunked)...\n')
const chunkVectors = []
for (const doc of perDocument) chunkVectors.push(await embed(doc.pieces, 'document'))

const score = (rankFor) => {
  const rows = []
  for (const judged of DOCS_JUDGED_QUERIES) {
    const ranked = rankFor(judged.query)
    rows.push({
      category: judged.category,
      ndcg: ndcgAt(ranked, judged.relevant, K),
      recall: recallAt(ranked, judged.relevant, K),
      rr: reciprocalRank(ranked, judged.relevant, K),
    })
  }
  return rows
}

const queryVectors = new Map()
for (const judged of DOCS_JUDGED_QUERIES) {
  const [v] = await embed([judged.query], 'query')
  queryVectors.set(judged.query, v)
}

const rankWhole = (query) => {
  const q = queryVectors.get(query)
  return perDocument
    .map((d, i) => ({ path: d.path, s: cosine(q, wholeVectors[i]) }))
    .sort((a, b) => b.s - a.s || (a.path < b.path ? -1 : 1))
    .map((e) => e.path)
}
const rankChunked = (query) => {
  const q = queryVectors.get(query)
  return perDocument
    .map((d, i) => ({ path: d.path, s: Math.max(...chunkVectors[i].map((v) => cosine(q, v))) }))
    .sort((a, b) => b.s - a.s || (a.path < b.path ? -1 : 1))
    .map((e) => e.path)
}

const whole = score(rankWhole)
const chunked = score(rankChunked)
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
const by = (rows, metric, cat) =>
  mean(rows.filter((r) => cat === undefined || r.category === cat).map((r) => r[metric]))

const out = process.stdout
out.write('\nSEMANTIC RANKING ONLY (no fusion) — truncated vs chunked\n')
out.write(`${'-'.repeat(58)}\n`)
for (const [label, metric] of [
  [`nDCG@${K}`, 'ndcg'],
  [`recall@${K}`, 'recall'],
  ['MRR', 'rr'],
]) {
  out.write(`${label}\n`)
  for (const cat of ['lexical', 'paraphrase', 'cross-lingual', undefined]) {
    const a = by(whole, metric, cat)
    const b = by(chunked, metric, cat)
    const name = cat ?? 'ALL'
    out.write(
      `  ${name.padEnd(16)} ${a.toFixed(3)} -> ${b.toFixed(3)}  ` +
        `${b - a >= 0 ? '+' : ''}${(b - a).toFixed(3)}\n`,
    )
  }
}

// The question this spike exists to answer is not "is it bigger" but "can
// this corpus tell". Same statistics the scoreboard uses.
out.write('\nis the difference distinguishable from the question set?\n')
out.write(`${'-'.repeat(58)}\n`)
for (const [label, metric] of [
  [`nDCG@${K}`, 'ndcg'],
  [`recall@${K}`, 'recall'],
  ['MRR', 'rr'],
]) {
  const deltas = chunked.map((row, i) => row[metric] - whole[i][metric])
  const ci = bootstrapCi(deltas)
  const test = pairedPermutationTest(deltas)
  const sd = standardDeviation(deltas)
  const sign = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`
  out.write(
    `${label.padEnd(10)} delta ${sign(test.observed)} ` +
      `[${sign(ci.low)}, ${sign(ci.high)}] ` +
      `p ${test.atSamplingFloor ? '<' : '='} ${test.p.toFixed(4)} ` +
      `(exact floor ${permutationFloor(deltas).toExponential(1)})\n`,
  )
  out.write(
    `           queries needed to call a delta of 0.05 significant: ` +
      `${requiredQueryCount({ sd, minDetectable: 0.05 }) ?? 'n/a'} (have ${deltas.length})\n`,
  )
}

out.write(
  `\ncost: ${chunkCount} embeddings instead of ${CORPUS.length}, ` +
    `${(chunkCount / CORPUS.length).toFixed(1)}x\n\n`,
)
