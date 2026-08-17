/**
 * Message protocol between the main process and the indexing utility process.
 *
 * The worker owns the only *write* connection to the database; main opens a
 * read-only connection for search. WAL makes that safe, and it means chunk text
 * never has to be shipped across the process boundary just to be stored.
 */

export type IndexPhase = 'starting' | 'scanning' | 'pruning' | 'embedding' | 'done'

export interface IndexCounters {
  filesSeen: number
  filesIndexed: number
  filesSkipped: number
  filesFailed: number
  filesRemoved: number
  chunksWritten: number
  /** Chunks that now have a vector. */
  chunksEmbedded: number
  /** Chunks still awaiting one. */
  chunksPending: number
}

export const EMPTY_COUNTERS: IndexCounters = {
  filesSeen: 0,
  filesIndexed: 0,
  filesSkipped: 0,
  filesFailed: 0,
  filesRemoved: 0,
  chunksWritten: 0,
  chunksEmbedded: 0,
  chunksPending: 0
}

// ------------------------------------------------------- main -> worker

export interface InitCommand {
  type: 'init'
  dbPath: string
  /** Where model weights are cached between runs. */
  modelCacheDir: string
}

export interface IndexCommand {
  type: 'index'
  requestId: string
  folders: string[]
}

export interface CancelCommand {
  type: 'cancel'
  requestId: string
}

export interface SearchCommand {
  type: 'search'
  requestId: string
  query: string
  limit?: number
}

export interface RemoveFolderCommand {
  type: 'remove-folder'
  requestId: string
  folder: string
}

/** Drops every stored vector and rebuilds, e.g. after a model change. */
export interface RebuildCommand {
  type: 'rebuild'
  requestId: string
  folders: string[]
}

export interface StatsCommand {
  type: 'stats'
  requestId: string
}

/** Keeps the worker's watch list in step with the user's folder list. */
export interface WatchCommand {
  type: 'watch'
  folders: string[]
}

export interface ShutdownCommand {
  type: 'shutdown'
}

export type WorkerCommand =
  | InitCommand
  | IndexCommand
  | CancelCommand
  | SearchCommand
  | RemoveFolderCommand
  | RebuildCommand
  | StatsCommand
  | WatchCommand
  | ShutdownCommand

// ------------------------------------------------------- worker -> main

export interface ReadyEvent {
  type: 'ready'
}

/**
 * First run has to fetch ~25MB of weights. Without this the app would sit on a
 * blank screen for a minute with no explanation.
 */
export interface ModelDownloadEvent {
  type: 'model-download'
  file: string
  loaded: number
  total: number
  /** 0-100, or null when the server did not send a content length. */
  percent: number | null
}

export interface ModelReadyEvent {
  type: 'model-ready'
  modelId: string
  dimension: number
}

export interface ProgressEvent {
  type: 'progress'
  requestId: string
  phase: IndexPhase
  counters: IndexCounters
  currentPath: string | null
}

export interface DoneEvent {
  type: 'done'
  requestId: string
  counters: IndexCounters
  cancelled: boolean
  elapsedMs: number
}

export interface ErrorEvent {
  type: 'error'
  requestId: string | null
  message: string
  /** True when the worker cannot continue at all, e.g. the model failed to load. */
  fatal: boolean
}

/** Mirrors core/search SearchResult, restated here so the protocol is self-contained. */
export interface SearchHit {
  chunkId: number
  filePath: string
  fileName: string
  headingPath: string | null
  startLine: number
  endLine: number
  text: string
  score: number
  matchedKeyword: boolean
  matchedSemantic: boolean
}

export interface SearchResultsEvent {
  type: 'search-results'
  requestId: string
  query: string
  hits: SearchHit[]
  elapsedMs: number
  /** False until the model has loaded; the UI shows keyword-only results meanwhile. */
  semanticAvailable: boolean
}

export interface StatsEvent {
  type: 'stats'
  requestId: string
  files: number
  chunks: number
  embeddedChunks: number
}

/** Emitted when the watcher notices changes and starts an incremental pass. */
export interface WatchTriggeredEvent {
  type: 'watch-triggered'
  changedPaths: number
}

export type WorkerEvent =
  | StatsEvent
  | WatchTriggeredEvent
  | ReadyEvent
  | ModelDownloadEvent
  | ModelReadyEvent
  | ProgressEvent
  | DoneEvent
  | SearchResultsEvent
  | ErrorEvent
