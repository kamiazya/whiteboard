/**
 * Turning text into vectors is a RUNTIME capability, not a shared-layer one:
 * the model runs through onnxruntime-node in the daemon and
 * onnxruntime-web + a Worker in the browser, which are different builds of
 * different packages. server-core therefore declares the port and never
 * loads a model itself — the same split `measure` already uses for fonts
 * (architecture-map.md).
 *
 * Optional everywhere. With no embedder, search is stage 0 exactly as it
 * shipped; supplying one adds semantic recall on top by rank fusion.
 */
export interface Embedder {
  /**
   * Embeddings for `texts`, in order, each L2-normalised so a dot product
   * IS the cosine similarity. Normalising here rather than at every call
   * site keeps the comparison one multiply — and makes "which similarity"
   * a property of the port instead of a convention each caller re-derives.
   *
   * `role` is required rather than optional because retrieval models are
   * commonly ASYMMETRIC: e5 was trained with a literal `query:` / `passage:`
   * prefix and loses accuracy without it. A default would be a default that
   * is wrong half the time, and silently — the results still look plausible.
   * A symmetric model simply ignores the argument.
   */
  embed(texts: readonly string[], role: 'query' | 'document'): Promise<readonly Float32Array[]>
  /** Vector width, for a cheap shape check before scoring. */
  readonly dimensions: number
  /**
   * What produced these vectors — model and precision, e.g.
   * `Xenova/multilingual-e5-small@q8`.
   *
   * Two embedders with the same width live in DIFFERENT vector spaces, so
   * a cached vector has to record which one made it or a later reader will
   * compare across them. Quantisation is the case that makes this concrete:
   * q8 and fp32 of one model are both 384-wide, measurably different
   * (nDCG@10 differs by 0.051 on JQaRA, p = 0.0003), and indistinguishable
   * by anything else on this interface. Cosine across the two is not a
   * similarity, and nothing throws — the results just quietly get worse.
   */
  readonly id: string
}

/** Cosine similarity of two L2-normalised vectors. */
function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number)
  return sum
}

/**
 * Documents ranked by vector similarity to `queryVector`, best first.
 * A brute-force scan: the research measured 10k vectors at 7.9ms, so an
 * ANN index would be machinery bought for a cost nobody is paying.
 */
export function rankByVector(
  queryVector: Float32Array,
  documents: readonly { documentId: string; vector: Float32Array }[],
): string[] {
  return documents
    .map((doc) => ({ id: doc.documentId, score: cosine(queryVector, doc.vector) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((entry) => entry.id)
}
