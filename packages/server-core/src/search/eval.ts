/**
 * Retrieval evaluation: the metrics and the statistics that say whether a
 * difference between two rankings is real.
 *
 * The metric choices follow standard IR practice rather than being invented
 * here, because the point of a scoreboard is to be comparable to something:
 *
 * - **nDCG@k is the primary metric.** BEIR chose it for a reason that
 *   applies directly to this corpus: precision and recall are rank-unaware,
 *   and MRR and MAP cannot express GRADED relevance. Japanese retrieval
 *   benchmarks (JMTEB, JQaRA) report nDCG@10 as well, so a number produced
 *   here means the same thing a number produced there means.
 * - **Recall@k and MRR are reported alongside**, not instead. Recall answers
 *   "did it find it at all" and MRR answers "how far did the reader have to
 *   look" — both are easier to reason about than nDCG, and both are wrong
 *   to optimise alone.
 *
 * Every metric is computed PER QUERY and averaged by the caller, because a
 * mean with no per-query values behind it cannot be tested for significance.
 * That is the whole reason this file exists rather than a one-line average.
 */

/**
 * documentPath -> relevance grade, 1..3. Anything absent is grade 0, not
 * relevant. The scale itself is documented on `JudgedQuery.relevant`,
 * which is where a person writing a judgement reads it.
 */
export type Judgments = Readonly<Record<string, 1 | 2 | 3>>

const gain = (grade: number): number => 2 ** grade - 1
const discount = (rank: number): number => Math.log2(rank + 1)

/**
 * Normalised discounted cumulative gain over the first `k` results.
 *
 * Answers 0 rather than NaN for a query with nothing relevant. An ideal DCG
 * of zero is a divide-by-zero that would otherwise propagate through every
 * mean the query is averaged into, turning one unjudged query into a
 * scoreboard-wide NaN — silent, and indistinguishable from a crash.
 */
export function ndcgAt(ranked: readonly string[], judgments: Judgments, k: number): number {
  let dcg = 0
  ranked.slice(0, k).forEach((path, index) => {
    dcg += gain(judgments[path] ?? 0) / discount(index + 1)
  })
  // The ideal ranking is capped at k too: with more relevant documents than
  // the cut can hold, a perfect ranking must still score 1.
  const ideal = Object.values(judgments)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, grade, index) => sum + gain(grade) / discount(index + 1), 0)
  return ideal === 0 ? 0 : dcg / ideal
}

/** Fraction of the judged-relevant documents that appear in the first `k`. */
export function recallAt(ranked: readonly string[], judgments: Judgments, k: number): number {
  const relevant = Object.keys(judgments)
  if (relevant.length === 0) return 0
  const found = new Set(ranked.slice(0, k).filter((path) => judgments[path] !== undefined))
  return found.size / relevant.length
}

/** 1 / rank of the first relevant result inside the cut, or 0. */
export function reciprocalRank(ranked: readonly string[], judgments: Judgments, k: number): number {
  const index = ranked.slice(0, k).findIndex((path) => judgments[path] !== undefined)
  return index === -1 ? 0 : 1 / (index + 1)
}

/**
 * A seeded generator, because every number this file produces is sampled
 * and a scoreboard that moves when nothing changed is not a scoreboard.
 * mulberry32 — small, and its quality is far beyond what resampling needs.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length

export interface PermutationResult {
  /** Mean of the per-query differences (system B minus system A). */
  readonly observed: number
  /** Two-sided p-value. Never 0 — see below. */
  readonly p: number
  readonly trials: number
  /**
   * True when `p` landed on `1 / (1 + trials)` — the smallest value SAMPLING
   * can produce, which is a property of the trial count and not of the
   * evidence. The real p-value is somewhere below it and this test cannot
   * say where.
   *
   * Reported because the alternative is a number that reads like a
   * measurement: `p = 0.0001` next to an exact floor of `2.3e-10` looks like
   * a result with room to spare, when it is really the sampler running out
   * of resolution. Print it as `p < 0.0001`.
   */
  readonly atSamplingFloor: boolean
}

/**
 * Paired sign-flip randomization test over per-query differences.
 *
 * Chosen over the alternatives on evidence rather than taste: comparing
 * significance tests for IR evaluation finds the randomization, bootstrap
 * and paired t tests practically indistinguishable, while the Wilcoxon
 * signed-rank and sign tests both detect poorly AND report significance
 * that is not there. The randomization test additionally assumes nothing
 * about the distribution of a metric like nDCG, which is bounded, skewed,
 * and full of ties — none of which a t-test is entitled to ignore.
 *
 * The null hypothesis is that the two systems are interchangeable for each
 * query, so flipping the sign of any difference is equally likely; the
 * p-value is the share of sign assignments whose mean difference is at
 * least as extreme as the observed one.
 *
 * `(1 + count) / (1 + trials)` rather than `count / trials`: a sampled test
 * has not observed every assignment, so it can never license p = 0. The
 * floor it CAN reach is about 2/2^n, which is why a handful of queries
 * cannot produce a significant result however large the effect.
 */
/**
 * The smallest p-value the EXACT test could report for these differences,
 * `2^(1 - m)` where m is the number of queries that differ at all.
 *
 * `pairedPermutationTest` samples rather than enumerating, so its estimate
 * scatters narrowly around this rather than being bounded below by it —
 * treat it as the level the sample is pinned to, not as a hard floor.
 *
 * Reported beside the p-value because the two are easy to confuse and the
 * confusion always flatters: a p of 0.03 against a floor of 0.031 is not a
 * comfortable result, it is the ONLY passing result the sample could
 * produce, and one query changing its mind would erase it. Ties do not
 * count — flipping the sign of a zero difference changes nothing — so this
 * is driven by how many queries the two systems actually disagree on, not
 * by how many were asked.
 */
export function permutationFloor(deltas: readonly number[]): number {
  const differing = deltas.filter((d) => d !== 0).length
  return differing === 0 ? 1 : 2 ** (1 - differing)
}

export function pairedPermutationTest(
  deltas: readonly number[],
  options: { trials?: number; seed?: number } = {},
): PermutationResult {
  const trials = options.trials ?? 10_000
  const next = rng(options.seed ?? 20260823)
  const observed = mean(deltas)
  const target = Math.abs(observed)
  let atLeastAsExtreme = 0
  for (let trial = 0; trial < trials; trial++) {
    let sum = 0
    for (const delta of deltas) sum += next() < 0.5 ? -delta : delta
    if (Math.abs(sum / (deltas.length || 1)) >= target - 1e-12) atLeastAsExtreme++
  }
  const p = (1 + atLeastAsExtreme) / (1 + trials)
  return { observed, p, trials, atSamplingFloor: atLeastAsExtreme === 0 }
}

export interface ConfidenceInterval {
  readonly mean: number
  readonly low: number
  readonly high: number
  readonly level: number
}

/**
 * Percentile bootstrap confidence interval for the mean, resampling QUERIES
 * with replacement.
 *
 * The query set is the sample; the retrieval itself is deterministic, so
 * queries are the only thing there is to resample. What the interval
 * answers is the question a single mean cannot: how much of this number is
 * the system, and how much is which twelve questions happened to be asked.
 *
 * ponytail: percentile method. BCa corrects for skew and bias and is what a
 * paper would use; it needs jackknife acceleration and roughly triples this
 * function. Worth adding when an interval's exact edge decides something.
 */
export function bootstrapCi(
  values: readonly number[],
  options: { resamples?: number; level?: number; seed?: number } = {},
): ConfidenceInterval {
  const resamples = options.resamples ?? 10_000
  const level = options.level ?? 0.95
  const next = rng(options.seed ?? 20260823)
  const n = values.length
  const means: number[] = []
  for (let sample = 0; sample < resamples; sample++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += values[Math.floor(next() * n)] as number
    means.push(n === 0 ? 0 : sum / n)
  }
  means.sort((a, b) => a - b)
  const tail = (1 - level) / 2
  const at = (q: number) => means[Math.min(means.length - 1, Math.floor(q * means.length))] ?? 0
  return { mean: mean(values), low: at(tail), high: at(1 - tail), level }
}

/** Standard deviation of a paired difference sample (n - 1 denominator). */
export function standardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1))
}

const Z_TWO_SIDED_95 = 1.959963985
const Z_POWER_80 = 0.841621234

/**
 * How many queries a corpus needs to detect a difference of
 * `minDetectable` in the mean, given the spread of the per-query
 * differences already observed.
 *
 * This is topic set size design in its simplest form, and it is the output
 * that makes a small corpus honest rather than merely small: instead of
 * "12 queries, take it or leave it", the instrument can say how far it is
 * from being able to answer the question being asked of it.
 *
 * `minDetectable` must be a difference chosen in ADVANCE as worth caring
 * about. Passing the difference you just observed computes "post-hoc
 * power", which is not a second opinion on the result — it is a
 * restatement of the p-value, and it always says the sample was about big
 * enough, because the observed effect is by construction the one this
 * sample could see. Ask instead how many queries a difference you would
 * ACT on would need.
 *
 * `undefined` when there is no difference to resolve — a request to detect
 * a difference of zero needs infinitely many queries, and reporting some
 * large finite number would imply otherwise.
 */
export function requiredQueryCount(options: {
  sd: number
  minDetectable: number
  alpha?: number
  power?: number
}): number | undefined {
  const { sd, minDetectable } = options
  if (minDetectable <= 0 || sd <= 0) return undefined
  // Only the conventional (alpha .05, power .80) pair is tabulated; anything
  // else would need an inverse normal CDF this file has no other use for.
  if ((options.alpha ?? 0.05) !== 0.05 || (options.power ?? 0.8) !== 0.8) return undefined
  return Math.ceil(((Z_TWO_SIDED_95 + Z_POWER_80) ** 2 * sd ** 2) / minDetectable ** 2)
}

export interface BaselineScores {
  readonly ndcg: number
  readonly recall: number
  readonly mrr: number
}

/**
 * What a ranking that knows nothing scores on a corpus of this shape.
 *
 * Without it a number like "nDCG 0.67" cannot be read at all. On a
 * six-document corpus a uniformly random ranking already returns the
 * answer inside the top five five times in six, so a recall@5 of 1.0 is
 * not evidence of anything — and that is exactly the kind of number a
 * scoreboard reports proudly if nobody computes the floor.
 */
export function randomBaseline(options: {
  corpusSize: number
  relevantCount: number
  k: number
  trials?: number
  seed?: number
}): BaselineScores {
  const { corpusSize, relevantCount, k } = options
  const trials = options.trials ?? 10_000
  const next = rng(options.seed ?? 20260823)
  const paths = Array.from({ length: corpusSize }, (_, i) => `d${i}`)
  const judgments: Record<string, 1 | 2 | 3> = {}
  for (let i = 0; i < Math.min(relevantCount, corpusSize); i++) judgments[`d${i}`] = 2
  let ndcg = 0
  let recall = 0
  let mrr = 0
  for (let trial = 0; trial < trials; trial++) {
    const shuffled = [...paths]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j] as string, shuffled[i] as string]
    }
    ndcg += ndcgAt(shuffled, judgments, k)
    recall += recallAt(shuffled, judgments, k)
    mrr += reciprocalRank(shuffled, judgments, k)
  }
  return { ndcg: ndcg / trials, recall: recall / trials, mrr: mrr / trials }
}
