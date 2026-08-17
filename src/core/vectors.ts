/**
 * Vector helpers.
 *
 * Embeddings are L2-normalised once, at write time. That turns cosine
 * similarity into a plain dot product at query time, which is the difference
 * between two square roots per comparison and none -- and search compares
 * against every stored vector.
 */

/** Wraps a Float32Array as bytes for SQLite BLOB binding. No copy. */
export function embeddingToBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)
}

/** Reads a SQLite BLOB back into a Float32Array. */
export function blobToEmbedding(blob: Uint8Array): Float32Array {
  if (blob.byteLength % 4 !== 0) {
    throw new Error(`Embedding blob length ${blob.byteLength} is not a multiple of 4`)
  }
  // `.slice()` copies into a fresh, offset-zero buffer. Necessary rather than
  // merely tidy: Float32Array requires 4-byte alignment, and a blob handed back
  // as a view into a larger pooled buffer carries no such guarantee.
  const copy = blob.slice()
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4)
}

/** Scales a vector to unit length, in place. Zero vectors are left alone. */
export function normalize(vector: Float32Array): Float32Array {
  let sumSquares = 0
  for (let i = 0; i < vector.length; i++) sumSquares += vector[i] * vector[i]

  const magnitude = Math.sqrt(sumSquares)
  if (magnitude === 0) return vector

  for (let i = 0; i < vector.length; i++) vector[i] /= magnitude
  return vector
}

/** Dot product. Equals cosine similarity when both inputs are normalised. */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`)
  }

  let total = 0
  for (let i = 0; i < a.length; i++) total += a[i] * b[i]
  return total
}
