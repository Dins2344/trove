import type { Database } from '../db/database'
import { blobToEmbedding } from '../vectors'

export interface VectorSearchHit {
  id: number
  /** Cosine similarity. Vectors are stored normalised, so this is a dot product. */
  score: number
}

/**
 * The seam that keeps an approximate index (sqlite-vec, HNSW) a contained
 * change rather than a rewrite, should the corpus ever outgrow a full scan.
 */
export interface VectorIndex {
  readonly size: number
  readonly dimension: number
  search(query: Float32Array, limit: number): VectorSearchHit[]
}

/**
 * Exhaustive nearest-neighbour search over a flat Float32Array.
 *
 * Deliberately not an ANN index. At this scale the arithmetic does not justify
 * one: 40k chunks x 384 dims is ~61MB resident and a full scan is a few tens of
 * milliseconds of sequential float multiplication -- comfortably inside the
 * latency budget, exactly, and with no recall loss, no index build step, and no
 * extra dependency to package. An approximate index would trade all of that
 * away to solve a problem this corpus does not have.
 *
 * One contiguous buffer rather than an array of Float32Arrays: 40k separate
 * typed arrays is 40k allocations and a pointer chase per comparison, which
 * defeats the cache prefetching that makes the scan fast in the first place.
 */
export class FlatVectorIndex implements VectorIndex {
  private constructor(
    private readonly ids: Int32Array,
    private readonly data: Float32Array,
    readonly dimension: number,
    readonly size: number
  ) {}

  static empty(dimension: number): FlatVectorIndex {
    return new FlatVectorIndex(new Int32Array(0), new Float32Array(0), dimension, 0)
  }

  /** Reads every embedded chunk into memory. */
  static load(db: Database): FlatVectorIndex {
    const countRow = db
      .prepare('SELECT count(*) AS n FROM chunks WHERE embedding IS NOT NULL')
      .get() as { n: number }
    const count = countRow.n

    if (count === 0) return FlatVectorIndex.empty(0)

    // Read one row to learn the width before allocating the big buffer.
    const first = db
      .prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL ORDER BY id LIMIT 1')
      .get() as { id: number; embedding: Uint8Array }
    const dimension = blobToEmbedding(first.embedding).length

    const ids = new Int32Array(count)
    const data = new Float32Array(count * dimension)

    let index = 0
    for (const row of db
      .prepare('SELECT id, embedding FROM chunks WHERE embedding IS NOT NULL ORDER BY id')
      .iterate() as Iterable<{ id: number; embedding: Uint8Array }>) {
      const vector = blobToEmbedding(row.embedding)
      // A row of the wrong width means the model changed without the index
      // being rebuilt. Skipping is safer than corrupting the stride.
      if (vector.length !== dimension) continue

      ids[index] = row.id
      data.set(vector, index * dimension)
      index++
    }

    return new FlatVectorIndex(ids, data, dimension, index)
  }

  search(query: Float32Array, limit: number): VectorSearchHit[] {
    if (this.size === 0 || limit <= 0) return []
    if (query.length !== this.dimension) {
      throw new Error(`Query has ${query.length} dims, index has ${this.dimension}`)
    }

    const k = Math.min(limit, this.size)
    // Bounded insertion beats sorting every candidate: k is ~50 against tens of
    // thousands of rows, so nearly every row fails one comparison and stops.
    const topScores = new Float64Array(k).fill(Number.NEGATIVE_INFINITY)
    const topIds = new Int32Array(k).fill(-1)

    const { data, ids, dimension } = this

    for (let row = 0; row < this.size; row++) {
      const base = row * dimension

      let score = 0
      for (let d = 0; d < dimension; d++) {
        score += data[base + d] * query[d]
      }

      if (score <= topScores[k - 1]) continue

      let position = k - 1
      while (position > 0 && topScores[position - 1] < score) {
        topScores[position] = topScores[position - 1]
        topIds[position] = topIds[position - 1]
        position--
      }
      topScores[position] = score
      topIds[position] = ids[row]
    }

    const hits: VectorSearchHit[] = []
    for (let i = 0; i < k; i++) {
      if (topIds[i] < 0) break
      hits.push({ id: topIds[i], score: topScores[i] })
    }
    return hits
  }
}
