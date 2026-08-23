/**
 * Checks the EMBEDDING PIPELINE against a published number.
 *
 * Everything else in this directory measures search quality on this
 * project's own documents, and all of it rests on an assumption nothing
 * verifies: that the embedder is being driven correctly. Prefixes, pooling,
 * L2 normalisation, quantisation — any of these can be subtly wrong and the
 * scoreboard would never say so, because it has nothing to compare against.
 * A corpus of one's own content cannot detect a systematically weakened
 * model; it just reports lower numbers and calls them the state of the art.
 *
 * JQaRA supplies the missing comparison. It is Japanese retrieval, scored
 * with nDCG@10 over 100 candidate passages per question, and the model this
 * daemon ships has a published score on it: multilingual-e5-small at
 * **0.4917**, from JQaRA's own dataset card.
 *
 * Expect slightly below that rather than exactly it — the daemon runs q8
 * quantised weights where the published figure is full precision. A small
 * shortfall is quantisation. A large one is a bug in how this repository
 * drives the model, and that is what this script exists to catch.
 *
 *   node --import tsx/esm scripts/measure/pipeline-check-jqara.mjs [--questions 60]
 *
 * The data is fetched at run time and never committed: JQaRA is CC-BY-SA
 * (questions from JAQKET, passages from Japanese Wikipedia), and a
 * measurement script has no business vendoring someone else's corpus.
 */
import { bootstrapCi, ndcgAt } from '@kamiazya/whiteboard-server-core'
import { searchModelCacheDir } from '../../src/server/search/search-embedder.ts'
import { DEFAULT_MODEL } from '../../src/server/search/transformers-embedder.ts'

/**
 * multilingual-e5-small's nDCG@10 on JQaRA's test split, from the dataset's
 * own card — the authoritative source, and worth naming because a search
 * result offered 0.636 for the same cell and building on it made a correct
 * pipeline look broken by a third.
 * https://huggingface.co/datasets/hotchpotch/JQaRA
 */
const PUBLISHED = 0.4917
const K = 10
const flagAt = process.argv.indexOf('--questions')
const WANT_QUESTIONS = flagAt === -1 ? 60 : Number(process.argv[flagAt + 1])

const DATASET = 'hotchpotch/JQaRA'
const PAGE = 100

async function fetchRows(offset, length) {
  const url =
    `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(DATASET)}` +
    `&config=default&split=test&offset=${offset}&length=${length}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`JQaRA fetch failed: ${res.status} ${res.statusText}`)
  const body = await res.json()
  if (body.error !== undefined) throw new Error(`JQaRA: ${body.error}`)
  return body.rows.map((r) => r.row)
}

process.stdout.write(`fetching ${WANT_QUESTIONS} questions from ${DATASET}...\n`)
// Rows arrive grouped by question, 100 candidates each, so a contiguous
// read is a clean sample of whole questions rather than of loose passages.
const byQuestion = new Map()
for (let offset = 0; byQuestion.size < WANT_QUESTIONS; offset += PAGE) {
  const rows = await fetchRows(offset, PAGE)
  if (rows.length === 0) break
  for (const row of rows) {
    const bucket = byQuestion.get(row.q_id) ?? { question: row.question, passages: [] }
    bucket.passages.push({
      id: String(row.passage_row_id),
      title: row.title,
      text: row.text,
      label: row.label,
    })
    byQuestion.set(row.q_id, bucket)
  }
}
// The last question read is usually cut off mid-way by the page boundary.
const questions = [...byQuestion.values()]
  .filter((q) => q.passages.length === PAGE)
  .slice(0, WANT_QUESTIONS)
process.stdout.write(
  `  ${questions.length} complete questions, ${questions.length * PAGE} passages\n`,
)

const { env, pipeline } = await import('@huggingface/transformers')
env.cacheDir = searchModelCacheDir()
const extractor = await pipeline('feature-extraction', DEFAULT_MODEL, { dtype: 'q8' })

/** Exactly what the daemon does — same prefixes, same pooling, same norm. */
async function embed(texts, role) {
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

const perQuestion = []
let done = 0
for (const q of questions) {
  const [qv] = await embed([q.question], 'query')
  const pv = await embed(
    q.passages.map((p) => `${p.title}\n${p.text}`),
    'document',
  )
  const ranked = q.passages
    .map((p, i) => ({ id: p.id, score: cosine(qv, pv[i]) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .map((e) => e.id)
  const judgments = {}
  for (const p of q.passages) if (p.label === 1) judgments[p.id] = 3
  perQuestion.push(ndcgAt(ranked, judgments, K))
  done++
  if (done % 10 === 0) process.stdout.write(`  scored ${done}/${questions.length}\n`)
}

const mean = perQuestion.reduce((a, b) => a + b, 0) / perQuestion.length
const ci = bootstrapCi(perQuestion)
const gap = mean - PUBLISHED

const out = process.stdout
out.write('\n')
out.write(`pipeline check — ${DEFAULT_MODEL} on JQaRA\n`)
out.write(`${'-'.repeat(58)}\n`)
out.write(
  `  ours (q8)      nDCG@${K} ${mean.toFixed(3)}  95% CI [${ci.low.toFixed(3)}, ${ci.high.toFixed(3)}]\n`,
)
out.write(
  `  published      nDCG@${K} ${PUBLISHED.toFixed(3)}  (full precision, all 1667 questions)\n`,
)
out.write(`  gap            ${gap >= 0 ? '+' : ''}${gap.toFixed(3)}\n`)
out.write(`  questions      ${questions.length} sampled of 1667\n`)
out.write('\n')
if (ci.low <= PUBLISHED && PUBLISHED <= ci.high) {
  out.write('  The published figure sits INSIDE our interval: this pipeline drives\n')
  out.write('  the model the way its authors did. Nothing here is evidence of a bug.\n')
} else if (gap < 0) {
  out.write('  The published figure is ABOVE our interval. Quantisation costs\n')
  out.write('  something, so a small shortfall is expected — but check the prefixes,\n')
  out.write('  the pooling and the normalisation before trusting any score this\n')
  out.write('  repository reports for semantic search.\n')
} else {
  out.write('  We score ABOVE the published figure, which a smaller sample can do\n')
  out.write('  by luck. Read the interval, not the point.\n')
}
out.write('\n')
