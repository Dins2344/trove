/**
 * Indexing worker. Runs as an Electron `utilityProcess`.
 *
 * Everything expensive lives here -- filesystem walking, PDF parsing, and ONNX
 * inference -- so the main process stays responsive enough to answer the global
 * hotkey while a full index is running.
 *
 * This process owns the only *write* connection to the database. Main opens a
 * separate read-only connection for search; WAL makes those two safe
 * concurrently, and it keeps chunk text from having to cross the process
 * boundary purely to be stored.
 */
import { watch, type FSWatcher } from 'chokidar'
import { Embedder } from '../core/embedder'
import { openDatabase, type Database } from '../core/db/database'
import {
  addFolder,
  clearEmbeddings,
  countPendingChunks,
  deleteFilesUnder,
  fetchPendingChunks,
  getIndexStats,
  isModelMismatched,
  removeFolder,
  setChunkEmbeddings,
  setMeta,
  META_EMBEDDING_DIM,
  META_MODEL_ID
} from '../core/db/repository'
import { DEFAULT_IGNORED_DIRS } from '../core/walker'
import { indexFolder } from '../core/indexer'
import { search } from '../core/search'
import { FlatVectorIndex } from '../core/search/vector-index'
import {
  EMPTY_COUNTERS,
  type IndexCounters,
  type IndexPhase,
  type WorkerCommand,
  type WorkerEvent
} from '../shared/worker-protocol'

/** utilityProcess supplies this; it is not part of the ambient Node typings. */
declare const process: NodeJS.Process & {
  parentPort: {
    on(event: 'message', listener: (message: { data: WorkerCommand }) => void): void
    postMessage(message: WorkerEvent): void
  }
}

/**
 * How many chunks go to the model at once.
 *
 * Measured ~850 chunks/sec on this machine, so the batch size is about
 * bounding peak memory and keeping cancellation responsive rather than
 * throughput -- a larger batch cannot be interrupted partway.
 */
const EMBED_BATCH_SIZE = 32

/**
 * Rows pulled from the database per pass, before being length-sorted into
 * batches.
 *
 * A transformer batch is padded to its longest member, so putting a 20-token
 * chunk in the same batch as a 220-token one means most of the compute for the
 * short one is spent on padding. Sorting a window by length first means each
 * batch is roughly uniform. Bigger window, better grouping -- bounded only by
 * how much text we are willing to hold in memory at once.
 */
const EMBED_WINDOW_SIZE = 512

let db: Database | null = null
let embedder: Embedder | null = null
const inFlight = new Map<string, AbortController>()

/**
 * Rebuilt lazily and dropped whenever embeddings change.
 *
 * Reloading is a linear read of the embedding column, so it is cheap next to
 * the indexing run that invalidated it -- and far cheaper than keeping the
 * in-memory copy incrementally consistent with every batch write.
 */
let vectorIndex: FlatVectorIndex | null = null

function getVectorIndex(database: Database): FlatVectorIndex {
  if (!vectorIndex) vectorIndex = FlatVectorIndex.load(database)
  return vectorIndex
}

function send(event: WorkerEvent): void {
  process.parentPort.postMessage(event)
}

function fail(requestId: string | null, error: unknown, fatal: boolean): void {
  send({
    type: 'error',
    requestId,
    message: error instanceof Error ? error.message : String(error),
    fatal
  })
}

async function handleInit(dbPath: string, modelCacheDir: string): Promise<void> {
  db = openDatabase(dbPath)
  send({ type: 'ready' })

  embedder = await Embedder.create({
    cacheDir: modelCacheDir,
    onDownloadProgress: (progress) => send({ type: 'model-download', ...progress })
  })

  // Vectors from a different model are not comparable with these ones. Silently
  // mixing them would degrade every ranking in a way that looks like the search
  // being mysteriously bad, so drop them and let the run rebuild.
  if (isModelMismatched(db, embedder.modelId)) {
    clearEmbeddings(db)
  }
  setMeta(db, META_MODEL_ID, embedder.modelId)
  setMeta(db, META_EMBEDDING_DIM, String(embedder.dimension))

  send({ type: 'model-ready', modelId: embedder.modelId, dimension: embedder.dimension })
}

async function handleIndex(requestId: string, folders: string[]): Promise<void> {
  if (!db) throw new Error('Worker received an index command before init')

  const controller = new AbortController()
  inFlight.set(requestId, controller)

  const started = Date.now()
  const counters: IndexCounters = { ...EMPTY_COUNTERS }
  let currentPath: string | null = null

  const report = (phase: IndexPhase): void => {
    send({ type: 'progress', requestId, phase, counters: { ...counters }, currentPath })
  }

  try {
    report('starting')

    // Phase 1: discover, extract, chunk. Cheap relative to embedding, and it
    // leaves chunks keyword-searchable even if the run is cancelled next.
    for (const folder of folders) {
      if (controller.signal.aborted) break

      // Remembered so the next launch re-scans it without asking again.
      addFolder(db, folder)

      const base = { ...counters }
      await indexFolder(db, folder, {
        signal: controller.signal,
        onProgress: (progress) => {
          counters.filesSeen = base.filesSeen + progress.filesSeen
          counters.filesIndexed = base.filesIndexed + progress.filesIndexed
          counters.filesSkipped = base.filesSkipped + progress.filesSkipped
          counters.filesFailed = base.filesFailed + progress.filesFailed
          counters.filesRemoved = base.filesRemoved + progress.filesRemoved
          counters.chunksWritten = base.chunksWritten + progress.chunksWritten
          currentPath = progress.currentPath

          // indexFolder finishing a folder is not the request finishing -- the
          // worker owns the overall lifecycle, and embedding still follows.
          // Forwarding its 'done' here made the UI flick back to "scanning".
          if (progress.phase === 'done') return
          report(progress.phase === 'pruning' ? 'pruning' : 'scanning')
        }
      })
    }

    // Phase 2: embed everything still lacking a vector. Driven off the database
    // rather than the just-scanned list, so an interrupted earlier run is
    // picked up and finished here.
    currentPath = null
    counters.chunksPending = countPendingChunks(db)
    report('embedding')

    await embedPending(controller.signal, counters, () => report('embedding'))

    const stats = getIndexStats(db)
    counters.chunksEmbedded = stats.embeddedChunks
    counters.chunksPending = stats.chunks - stats.embeddedChunks

    send({
      type: 'done',
      requestId,
      counters: { ...counters },
      cancelled: controller.signal.aborted,
      elapsedMs: Date.now() - started
    })
  } catch (error) {
    fail(requestId, error, false)
  } finally {
    inFlight.delete(requestId)
  }
}

/**
 * Embeds pending chunks in batches until none remain or the run is cancelled.
 */
async function embedPending(
  signal: AbortSignal,
  counters: IndexCounters,
  report: () => void
): Promise<void> {
  if (!db) return
  if (!embedder) throw new Error('Model is not ready yet')

  for (;;) {
    if (signal.aborted) return

    const window = fetchPendingChunks(db, EMBED_WINDOW_SIZE)
    if (window.length === 0) return

    // Group similar lengths together to minimise padding waste.
    window.sort((a, b) => a.text.length - b.text.length)

    for (let offset = 0; offset < window.length; offset += EMBED_BATCH_SIZE) {
      if (signal.aborted) return

      const batch = window.slice(offset, offset + EMBED_BATCH_SIZE)
      const vectors = await embedder.embed(batch.map((chunk) => chunk.text))

      // Written immediately rather than accumulated: cancelling between
      // inference and write would throw away work already paid for.
      setChunkEmbeddings(
        db,
        batch.map((chunk, index) => ({ id: chunk.id, embedding: vectors[index] }))
      )

      // The cached index no longer reflects the table. Dropped per batch rather
      // than once at the end so a search during indexing sees the new vectors;
      // rebuilding is a linear column read, and searches during an index run
      // are rare.
      vectorIndex = null

      counters.chunksEmbedded += batch.length
      counters.chunksPending = Math.max(0, counters.chunksPending - batch.length)
      report()
    }
  }
}

async function handleSearch(requestId: string, query: string, limit?: number): Promise<void> {
  if (!db) throw new Error('Worker received a search before init')

  const started = Date.now()

  try {
    // Search stays useful before the model has finished loading: the keyword
    // leg alone still answers exact-term queries, which is better than an
    // empty box during first-run download.
    const index = embedder ? getVectorIndex(db) : FlatVectorIndex.empty(0)

    const hits = await search(
      db,
      index,
      async (text) => {
        if (!embedder) throw new Error('Model not ready')
        const [vector] = await embedder.embed([text])
        return vector
      },
      query,
      { limit: limit ?? 20 }
    )

    send({
      type: 'search-results',
      requestId,
      query,
      hits,
      elapsedMs: Date.now() - started,
      semanticAvailable: embedder !== null
    })
  } catch (error) {
    fail(requestId, error, false)
  }
}

// --------------------------------------------------------------- watching

/**
 * How long to wait after the last filesystem event before re-scanning.
 *
 * Saving a file in an editor produces a burst of events, and a build or a git
 * checkout produces thousands. Re-indexing per event would be pure waste; the
 * debounce collapses a burst into one incremental pass.
 */
const WATCH_DEBOUNCE_MS = 2500

let watcher: FSWatcher | null = null
let watchedFolders: string[] = []
let watchTimer: NodeJS.Timeout | null = null
let pendingChangeCount = 0

/** Mirrors the walker's rules so the watcher does not wake for build output. */
function isIgnoredPath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some((segment) => segment.startsWith('.') || DEFAULT_IGNORED_DIRS.has(segment))
}

async function setWatchedFolders(folders: string[]): Promise<void> {
  watchedFolders = folders

  await watcher?.close()
  watcher = null
  if (folders.length === 0) return

  watcher = watch(folders, {
    ignoreInitial: true,
    ignored: (path: string) => isIgnoredPath(path),
    // Large files are still being written when the first event fires; indexing
    // a half-written file would store truncated text until the next change.
    awaitWriteFinish: { stabilityThreshold: 700, pollInterval: 150 }
  })

  watcher.on('all', () => {
    pendingChangeCount++
    scheduleRescan()
  })
  watcher.on('error', (error) => fail(null, error, false))
}

function scheduleRescan(): void {
  if (watchTimer) clearTimeout(watchTimer)

  watchTimer = setTimeout(() => {
    watchTimer = null

    // Never start a second pass on top of a running one: the indexer is the
    // sole writer, and its own writes would otherwise re-trigger the watcher.
    if (inFlight.size > 0) {
      scheduleRescan()
      return
    }

    const changed = pendingChangeCount
    pendingChangeCount = 0
    if (changed === 0 || watchedFolders.length === 0) return

    send({ type: 'watch-triggered', changedPaths: changed })
    // Cheap: the mtime gate skips everything that did not actually change.
    void handleIndex(`watch-${Date.now()}`, watchedFolders)
  }, WATCH_DEBOUNCE_MS)
}

// --------------------------------------------------------------- commands

function handleRemoveFolder(requestId: string, folder: string): void {
  if (!db) throw new Error('Worker received remove-folder before init')

  const removed = deleteFilesUnder(db, folder)
  removeFolder(db, folder)
  // Those vectors are gone; the cached index still holds them.
  vectorIndex = null

  const stats = getIndexStats(db)
  send({
    type: 'stats',
    requestId,
    files: stats.files,
    chunks: stats.chunks,
    embeddedChunks: stats.embeddedChunks
  })
  console.log(`[trove:worker] removed ${removed} files under ${folder}`)
}

function handleStats(requestId: string): void {
  if (!db) throw new Error('Worker received stats before init')

  const stats = getIndexStats(db)
  send({
    type: 'stats',
    requestId,
    files: stats.files,
    chunks: stats.chunks,
    embeddedChunks: stats.embeddedChunks
  })
}

function handleShutdown(): void {
  if (watchTimer) clearTimeout(watchTimer)
  void watcher?.close()

  for (const controller of inFlight.values()) controller.abort()
  void embedder?.dispose()
  db?.close()
  process.exit(0)
}

process.parentPort.on('message', (message) => {
  const command = message.data

  switch (command.type) {
    case 'init':
      handleInit(command.dbPath, command.modelCacheDir).catch((error) => {
        // Without a model the app cannot do its one job, so this is fatal.
        fail(null, error, true)
      })
      break

    case 'index':
      void handleIndex(command.requestId, command.folders)
      break

    case 'search':
      void handleSearch(command.requestId, command.query, command.limit)
      break

    case 'remove-folder':
      try {
        handleRemoveFolder(command.requestId, command.folder)
      } catch (error) {
        fail(command.requestId, error, false)
      }
      break

    case 'rebuild':
      if (db) {
        // Chunks survive; only the vectors are discarded, so keyword search
        // keeps working while the embeddings are regenerated.
        clearEmbeddings(db)
        vectorIndex = null
      }
      void handleIndex(command.requestId, command.folders)
      break

    case 'stats':
      try {
        handleStats(command.requestId)
      } catch (error) {
        fail(command.requestId, error, false)
      }
      break

    case 'watch':
      void setWatchedFolders(command.folders)
      break

    case 'cancel':
      inFlight.get(command.requestId)?.abort()
      break

    case 'shutdown':
      handleShutdown()
      break
  }
})

// A crash here must be reported, not silently kill indexing forever.
process.on('uncaughtException', (error) => fail(null, error, true))
process.on('unhandledRejection', (reason) => fail(null, reason, true))
