import type { Database } from '../db/database'
import { buildFtsQuery } from './fts-query'
import { reciprocalRankFusion, DEFAULT_RRF_K, type RankedItem } from './rrf'
import type { VectorIndex } from './vector-index'

export { buildFtsQuery } from './fts-query'
export { reciprocalRankFusion, DEFAULT_RRF_K } from './rrf'
export { FlatVectorIndex, type VectorIndex } from './vector-index'

export interface SearchResult {
  chunkId: number
  filePath: string
  fileName: string
  headingPath: string | null
  startLine: number
  endLine: number
  text: string
  /** Fused RRF score. Comparable within one result set, not across queries. */
  score: number
  matchedKeyword: boolean
  matchedSemantic: boolean
}

export interface SearchOptions {
  /** Results returned to the caller. */
  limit?: number
  /** Candidates pulled from each leg before fusion. */
  candidatesPerLeg?: number
  rrfK?: number
  /**
   * Caps how many passages one file may contribute.
   *
   * Without it a single long document that matches well floods the entire
   * result list, which is useless for the "which file was that in?" question
   * this app exists to answer.
   */
  maxPerFile?: number
}

const DEFAULTS = {
  limit: 20,
  candidatesPerLeg: 100,
  rrfK: DEFAULT_RRF_K,
  maxPerFile: 2
} as const

export type EmbedQuery = (text: string) => Promise<Float32Array>

interface ChunkRow {
  id: number
  text: string
  start_line: number
  end_line: number
  heading_path: string | null
  path: string
}

/** BM25 leg. Returns chunk ids best-first. */
function keywordCandidates(db: Database, query: string, limit: number): RankedItem[] {
  const match = buildFtsQuery(query)
  if (match === null) return []

  try {
    const rows = db
      .prepare(
        `SELECT rowid AS id
         FROM chunks_fts
         WHERE chunks_fts MATCH ?
         ORDER BY bm25(chunks_fts)
         LIMIT ?`
      )
      .all(match, limit) as unknown as { id: number }[]
    return rows.map((row) => ({ id: row.id }))
  } catch {
    // A MATCH expression the tokenizer still could not digest should degrade to
    // semantic-only, never take the whole search down.
    return []
  }
}

/**
 * Hybrid search: BM25 and vector similarity, fused with RRF.
 *
 * Both legs are needed because each fails where the other works. Pure semantic
 * search is poor at exact tokens -- error codes, function names, `ENOENT` --
 * because they carry little meaning to embed. Pure keyword search cannot match
 * "how do I get paid" to a document titled "Invoicing Procedure" at all.
 */
export async function search(
  db: Database,
  index: VectorIndex,
  embedQuery: EmbedQuery,
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit, candidatesPerLeg, rrfK, maxPerFile } = { ...DEFAULTS, ...options }

  const trimmed = query.trim()
  if (trimmed.length === 0) return []

  const keyword = keywordCandidates(db, trimmed, candidatesPerLeg)

  let semantic: RankedItem[] = []
  if (index.size > 0) {
    const vector = await embedQuery(trimmed)
    semantic = index.search(vector, candidatesPerLeg).map((hit) => ({ id: hit.id }))
  }

  if (keyword.length === 0 && semantic.length === 0) return []

  const keywordIds = new Set(keyword.map((item) => item.id))
  const semanticIds = new Set(semantic.map((item) => item.id))
  const fused = reciprocalRankFusion([keyword, semantic], rrfK)

  // Hydrate only what might survive the per-file cap, not every candidate.
  const hydrateCount = Math.min(fused.length, limit * Math.max(2, maxPerFile) + limit)
  const shortlist = fused.slice(0, hydrateCount)
  if (shortlist.length === 0) return []

  const placeholders = shortlist.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT c.id, c.text, c.start_line, c.end_line, c.heading_path, f.path
       FROM chunks c
       JOIN files f ON f.id = c.file_id
       WHERE c.id IN (${placeholders})`
    )
    .all(...shortlist.map((item) => item.id)) as unknown as ChunkRow[]

  const byId = new Map(rows.map((row) => [row.id, row]))

  const results: SearchResult[] = []
  const perFile = new Map<string, number>()

  for (const item of shortlist) {
    if (results.length >= limit) break

    const row = byId.get(item.id)
    // A chunk deleted between ranking and hydration is simply gone.
    if (!row) continue

    const used = perFile.get(row.path) ?? 0
    if (used >= maxPerFile) continue
    perFile.set(row.path, used + 1)

    results.push({
      chunkId: row.id,
      filePath: row.path,
      fileName: row.path.split(/[\\/]/).pop() ?? row.path,
      headingPath: row.heading_path,
      startLine: row.start_line,
      endLine: row.end_line,
      text: row.text,
      score: item.score,
      matchedKeyword: keywordIds.has(row.id),
      matchedSemantic: semanticIds.has(row.id)
    })
  }

  return results
}
