/**
 * Reciprocal Rank Fusion: combine several ranked lists into one score per
 * document, using only each document's RANK within each list.
 *
 * Ranks rather than scores because the retrievers being fused are not on a
 * comparable scale — BM25 is unbounded and corpus-relative, cosine
 * similarity sits in a narrow band well above zero even for unrelated text
 * (the research measured 0.63 between a cat sentence and a search query).
 * Adding or weighting those numbers directly produces a ranking dominated
 * by whichever scale happens to be larger, which is why the standard fusion
 * throws the magnitudes away.
 *
 * K dampens the top of each list so a single retriever's first place cannot
 * outrank agreement between two. 60 is the value the original RRF paper
 * settled on and what every hybrid-search implementation since uses; it is
 * not tuned here, and tuning it would need the scoreboard to move.
 */
const K = 60

/** documentId -> fused score, higher is better. */
export function fuseByRank(rankedLists: readonly (readonly string[])[]): Map<string, number> {
  const fused = new Map<string, number>()
  for (const list of rankedLists) {
    list.forEach((id, index) => {
      fused.set(id, (fused.get(id) ?? 0) + 1 / (K + index + 1))
    })
  }
  return fused
}
