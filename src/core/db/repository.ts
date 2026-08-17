import { sep } from 'node:path'
import type { Chunk } from '../chunker'
import type { IndexedFileState } from '../hash'
import { EXTRACTOR_VERSION } from '../extract/version'
import { embeddingToBlob } from '../vectors'
import { transaction, type Database } from './database'

/**
 * Every SQL statement in the app lives here.
 *
 * Callers work in camelCase domain objects; the snake_case column mapping stops
 * at this boundary, so a schema rename never leaks into the indexer or the
 * search path.
 */

export type FileStatus = 'indexed' | 'failed'

export interface FileRecord {
  id: number
  path: string
  mtimeMs: number
  sizeBytes: number
  contentHash: string
  indexedAt: number
  status: FileStatus
  errorMessage: string | null
}

interface FileRow {
  id: number
  path: string
  mtime_ms: number
  size_bytes: number
  content_hash: string
  indexed_at: number
  status: string
  error_message: string | null
  extractor_version: number
}

function toFileRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    path: row.path,
    mtimeMs: row.mtime_ms,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    indexedAt: row.indexed_at,
    status: row.status === 'failed' ? 'failed' : 'indexed',
    errorMessage: row.error_message
  }
}

export function getFileByPath(db: Database, path: string): FileRecord | undefined {
  const row = db.prepare('SELECT * FROM files WHERE path = ?').get(path) as FileRow | undefined
  return row ? toFileRecord(row) : undefined
}

/**
 * Loads the state of every known file in one query.
 *
 * The indexer needs to compare thousands of files against what is already
 * stored; doing that with one SELECT per file turns a metadata scan into the
 * slowest part of a re-index.
 */
export function loadIndexedState(db: Database): Map<string, IndexedFileState> {
  const state = new Map<string, IndexedFileState>()

  for (const row of db
    .prepare(
      'SELECT path, mtime_ms, size_bytes, content_hash, status, extractor_version FROM files'
    )
    .iterate() as Iterable<
    Pick<
      FileRow,
      'path' | 'mtime_ms' | 'size_bytes' | 'content_hash' | 'status' | 'extractor_version'
    >
  >) {
    state.set(row.path, {
      mtimeMs: row.mtime_ms,
      sizeBytes: row.size_bytes,
      contentHash: row.content_hash,
      // Only worth retrying if the extractor has moved on since it failed.
      retryable: row.status === 'failed' && row.extractor_version < EXTRACTOR_VERSION
    })
  }

  return state
}

export interface UpsertFileInput {
  path: string
  mtimeMs: number
  sizeBytes: number
  contentHash: string
  status?: FileStatus
  errorMessage?: string | null
}

/**
 * Inserts or updates the file row and returns its id.
 *
 * `RETURNING` gives the correct id on both the insert and the update path;
 * `lastInsertRowid` only tells the truth about the former.
 */
export function upsertFile(db: Database, input: UpsertFileInput): number {
  const row = db
    .prepare(
      `INSERT INTO files
         (path, mtime_ms, size_bytes, content_hash, indexed_at, status, error_message, extractor_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         mtime_ms          = excluded.mtime_ms,
         size_bytes        = excluded.size_bytes,
         content_hash      = excluded.content_hash,
         indexed_at        = excluded.indexed_at,
         status            = excluded.status,
         error_message     = excluded.error_message,
         extractor_version = excluded.extractor_version
       RETURNING id`
    )
    .get(
      input.path,
      input.mtimeMs,
      input.sizeBytes,
      input.contentHash,
      Date.now(),
      input.status ?? 'indexed',
      input.errorMessage ?? null,
      // Stamped on every row, not just failures. Only failures consult it
      // today, but recording it for successes keeps the option open of
      // re-processing files that extracted poorly rather than threw.
      EXTRACTOR_VERSION
    ) as { id: number }

  return row.id
}

/**
 * Refreshes only mtime/size, for a file that was rewritten with identical
 * content. Skips the delete-and-reinsert of chunks, and with it the embedding
 * work, which is the entire point of the two-stage change check.
 */
export function touchFileMetadata(
  db: Database,
  path: string,
  mtimeMs: number,
  sizeBytes: number
): void {
  db.prepare('UPDATE files SET mtime_ms = ?, size_bytes = ?, indexed_at = ? WHERE path = ?').run(
    mtimeMs,
    sizeBytes,
    Date.now(),
    path
  )
}

export interface ChunkWithEmbedding extends Chunk {
  embedding?: Float32Array
}

/**
 * Replaces a file's chunks wholesale.
 *
 * Diffing chunks against their previous versions is not worth it: an edit near
 * the top of a document shifts every chunk after it, so the common case would
 * re-embed almost everything anyway.
 */
export function replaceChunks(
  db: Database,
  fileId: number,
  chunks: readonly ChunkWithEmbedding[]
): void {
  transaction(db, () => {
    // The FTS delete trigger fires here, keeping the inverted index in step.
    db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId)

    const insert = db.prepare(
      `INSERT INTO chunks (file_id, ordinal, text, start_line, end_line, heading_path, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )

    for (const chunk of chunks) {
      insert.run(
        fileId,
        chunk.ordinal,
        chunk.text,
        chunk.startLine,
        chunk.endLine,
        chunk.headingPath,
        chunk.embedding ? embeddingToBlob(chunk.embedding) : null
      )
    }
  })
}

export function setChunkEmbedding(db: Database, chunkId: number, embedding: Float32Array): void {
  db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(
    embeddingToBlob(embedding),
    chunkId
  )
}

export interface PendingChunk {
  id: number
  text: string
}

export function countPendingChunks(db: Database): number {
  const row = db.prepare('SELECT count(*) AS n FROM chunks WHERE embedding IS NULL').get() as {
    n: number
  }
  return row.n
}

/**
 * Fetches the next batch of chunks awaiting a vector.
 *
 * Re-querying per batch rather than holding one cursor open: the loop writes
 * back into the same table it is reading from, and a live cursor over rows
 * being updated is asking for trouble. The `embedding IS NULL` set shrinks each
 * pass, so this terminates.
 */
export function fetchPendingChunks(db: Database, limit: number): PendingChunk[] {
  return db
    .prepare('SELECT id, text FROM chunks WHERE embedding IS NULL ORDER BY id LIMIT ?')
    .all(limit) as unknown as PendingChunk[]
}

/** Writes a batch of vectors in one transaction. */
export function setChunkEmbeddings(
  db: Database,
  entries: readonly { id: number; embedding: Float32Array }[]
): void {
  if (entries.length === 0) return

  transaction(db, () => {
    const update = db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?')
    for (const entry of entries) {
      update.run(embeddingToBlob(entry.embedding), entry.id)
    }
  })
}

/** Removes a file and, via ON DELETE CASCADE, all of its chunks. */
export function deleteFileByPath(db: Database, path: string): void {
  db.prepare('DELETE FROM files WHERE path = ?').run(path)
}

/**
 * Removes every indexed file at or beneath a folder.
 *
 * Uses `substr` rather than `LIKE 'prefix%'` on purpose: LIKE would need the
 * prefix escaped against its `%` and `_` wildcards, and the conventional escape
 * character is a backslash -- which appears in literally every Windows path.
 * A prefix comparison sidesteps the whole problem.
 *
 * @returns how many files were removed.
 */
export function deleteFilesUnder(db: Database, folder: string): number {
  const prefix = folder.endsWith(sep) ? folder : `${folder}${sep}`

  const result = db
    .prepare('DELETE FROM files WHERE path = ? OR substr(path, 1, ?) = ?')
    .run(folder, prefix.length, prefix)

  return Number(result.changes)
}

export function markFileFailed(db: Database, path: string, message: string): void {
  db.prepare('UPDATE files SET status = ?, error_message = ? WHERE path = ?').run(
    'failed',
    message,
    path
  )
}

export interface IndexStats {
  files: number
  chunks: number
  embeddedChunks: number
}

export function getIndexStats(db: Database): IndexStats {
  const files = db.prepare('SELECT count(*) AS n FROM files').get() as { n: number }
  const chunks = db.prepare('SELECT count(*) AS n FROM chunks').get() as { n: number }
  const embedded = db
    .prepare('SELECT count(*) AS n FROM chunks WHERE embedding IS NOT NULL')
    .get() as { n: number }

  return { files: files.n, chunks: chunks.n, embeddedChunks: embedded.n }
}

// ------------------------------------------------------------------- folders

export interface FolderRecord {
  id: number
  path: string
  addedAt: number
}

export function addFolder(db: Database, path: string): void {
  db.prepare('INSERT OR IGNORE INTO folders (path, added_at) VALUES (?, ?)').run(path, Date.now())
}

export function listFolders(db: Database): FolderRecord[] {
  const rows = db.prepare('SELECT id, path, added_at FROM folders ORDER BY path').all() as {
    id: number
    path: string
    added_at: number
  }[]
  return rows.map((row) => ({ id: row.id, path: row.path, addedAt: row.added_at }))
}

export function removeFolder(db: Database, path: string): void {
  db.prepare('DELETE FROM folders WHERE path = ?').run(path)
}

// ---------------------------------------------------------------------- meta

export function getMeta(db: Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value)
}

export const META_MODEL_ID = 'model_id'
export const META_EMBEDDING_DIM = 'embedding_dim'

/**
 * Vectors from different models are not comparable, so a model change has to
 * invalidate the whole index rather than silently return nonsense rankings.
 *
 * @returns true when the stored index was built by a different model.
 */
export function isModelMismatched(db: Database, modelId: string): boolean {
  const stored = getMeta(db, META_MODEL_ID)
  return stored !== undefined && stored !== modelId
}

export function clearEmbeddings(db: Database): void {
  db.exec('UPDATE chunks SET embedding = NULL')
}
