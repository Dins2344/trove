import { chunkText, type ChunkOptions } from './chunker'
import { withTrailingSeparator } from './path-utils'
import type { Database } from './db/database'
import {
  deleteFileByPath,
  loadIndexedState,
  markFileFailed,
  replaceChunks,
  touchFileMetadata,
  upsertFile
} from './db/repository'
import { extractDocument } from './extract'
import { compareContent, compareMetadata, hashFile } from './hash'
import { walk, type WalkOptions } from './walker'

export interface IndexProgress {
  phase: 'scanning' | 'pruning' | 'done'
  filesSeen: number
  /** Extracted, chunked and written. */
  filesIndexed: number
  /** Unchanged, or rewritten with identical content. */
  filesSkipped: number
  filesFailed: number
  /** Removed because they no longer exist on disk. */
  filesRemoved: number
  chunksWritten: number
  currentPath: string | null
}

export interface IndexOptions {
  signal?: AbortSignal
  onProgress?: (progress: Readonly<IndexProgress>) => void
  chunkOptions?: ChunkOptions
  walkOptions?: WalkOptions
  /** Emit progress at most this often, to avoid flooding the UI. */
  progressIntervalMs?: number
}

/**
 * Indexes one folder into the database.
 *
 * Embeddings are deliberately not produced here -- chunks are written with a
 * NULL embedding and filled in by the embedding worker. Keeping extraction and
 * embedding separate means a slow model never blocks the far cheaper work of
 * discovering what changed, and an interrupted run leaves behind chunks that
 * are still searchable by keyword.
 */
export async function indexFolder(
  db: Database,
  root: string,
  options: IndexOptions = {}
): Promise<IndexProgress> {
  const { signal, onProgress, chunkOptions, walkOptions } = options
  const progressIntervalMs = options.progressIntervalMs ?? 100

  const progress: IndexProgress = {
    phase: 'scanning',
    filesSeen: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesFailed: 0,
    filesRemoved: 0,
    chunksWritten: 0,
    currentPath: null
  }

  let lastEmit = 0
  const emit = (force = false): void => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && now - lastEmit < progressIntervalMs) return
    lastEmit = now
    onProgress({ ...progress })
  }

  // One query up front beats one per file; see loadIndexedState.
  const known = loadIndexedState(db)
  const seen = new Set<string>()

  for await (const entry of walk(root, { ...walkOptions, signal })) {
    if (signal?.aborted) break

    seen.add(entry.path)
    progress.filesSeen++
    progress.currentPath = entry.path

    const previous = known.get(entry.path)

    // Gate 1: metadata only, no file read at all.
    if (compareMetadata(previous, entry) === 'unchanged') {
      progress.filesSkipped++
      emit()
      continue
    }

    try {
      // Gate 2: hash the bytes. Catches format-on-save and copies, which change
      // mtime without changing content.
      const contentHash = await hashFile(entry.path)
      if (compareContent(previous, contentHash) === 'metadata-only') {
        touchFileMetadata(db, entry.path, entry.mtimeMs, entry.sizeBytes)
        progress.filesSkipped++
        emit()
        continue
      }

      const document = await extractDocument(entry.path)
      if (document === null) {
        // Nothing extractable. Record it so we do not retry every scan.
        upsertFile(db, {
          path: entry.path,
          mtimeMs: entry.mtimeMs,
          sizeBytes: entry.sizeBytes,
          contentHash
        })
        progress.filesSkipped++
        emit()
        continue
      }

      const chunks = chunkText(document.text, chunkOptions)
      const fileId = upsertFile(db, {
        path: entry.path,
        mtimeMs: entry.mtimeMs,
        sizeBytes: entry.sizeBytes,
        contentHash
      })
      replaceChunks(db, fileId, chunks)

      progress.filesIndexed++
      progress.chunksWritten += chunks.length
    } catch (error) {
      // A single unreadable or corrupt file must not end the run.
      progress.filesFailed++
      try {
        upsertFile(db, {
          path: entry.path,
          mtimeMs: entry.mtimeMs,
          sizeBytes: entry.sizeBytes,
          contentHash: '',
          status: 'failed',
          errorMessage: (error as Error).message
        })
        markFileFailed(db, entry.path, (error as Error).message)
      } catch {
        // Storage itself is failing; the counter above is all we can record.
      }
    }

    emit()
  }

  // Files that were indexed previously but are no longer on disk. Without this
  // a deleted file keeps returning as a search result forever.
  if (!signal?.aborted) {
    progress.phase = 'pruning'
    emit(true)

    const prefix = withTrailingSeparator(root)
    for (const knownPath of known.keys()) {
      if (seen.has(knownPath)) continue
      // Only prune inside the folder that was just scanned; other roots were
      // not visited and their files are not missing, merely unvisited.
      if (!knownPath.startsWith(prefix) && knownPath !== root) continue

      deleteFileByPath(db, knownPath)
      progress.filesRemoved++
    }
  }

  progress.phase = 'done'
  progress.currentPath = null
  emit(true)

  return progress
}
