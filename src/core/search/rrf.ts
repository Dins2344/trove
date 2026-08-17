/**
 * Reciprocal Rank Fusion.
 *
 * Combines several ranked lists into one. The trick is that it ignores the
 * scores entirely and uses only each item's *position* in each list:
 *
 *     score(d) = sum over lists of  1 / (k + rank(d))
 *
 * That matters here because the two retrieval legs produce numbers that cannot
 * be compared. BM25 is an unbounded relevance score where more negative is
 * better in SQLite; cosine similarity is bounded to [-1, 1]. Normalising them
 * onto a common scale means inventing a conversion factor and tuning it per
 * corpus. RRF sidesteps the question: rank 1 is rank 1 in any units.
 *
 * `k` damps the influence of top positions. At the conventional k = 60 the gap
 * between rank 1 and rank 2 is small, so an item both legs rank highly beats an
 * item that only one leg loves -- which is exactly the behaviour wanted from a
 * hybrid search.
 */

export interface RankedItem {
  id: number
}

export interface FusedResult {
  id: number
  score: number
  /** Which input lists contained this id, by their index. Useful for debugging. */
  sources: number[]
}

export const DEFAULT_RRF_K = 60

export function reciprocalRankFusion(
  lists: readonly (readonly RankedItem[])[],
  k: number = DEFAULT_RRF_K
): FusedResult[] {
  const scores = new Map<number, { score: number; sources: number[] }>()

  lists.forEach((list, listIndex) => {
    list.forEach((item, position) => {
      // Ranks are 1-based: at rank 0 the k term would be the only damping.
      const rank = position + 1
      const contribution = 1 / (k + rank)

      const existing = scores.get(item.id)
      if (existing) {
        existing.score += contribution
        existing.sources.push(listIndex)
      } else {
        scores.set(item.id, { score: contribution, sources: [listIndex] })
      }
    })
  })

  return [...scores.entries()]
    .map(([id, entry]) => ({ id, score: entry.score, sources: entry.sources }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      // Deterministic tie-break, so equal-scoring results do not reshuffle
      // between identical queries.
      return a.id - b.id
    })
}
