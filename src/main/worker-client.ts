import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type {
  SearchResultsEvent,
  StatsEvent,
  WorkerCommand,
  WorkerEvent
} from '../shared/worker-protocol'

type EventListener = (event: WorkerEvent) => void

/** Worker events that answer a specific request rather than broadcasting. */
type ReplyEvent = SearchResultsEvent | StatsEvent

interface PendingRequest {
  resolve: (event: ReplyEvent) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** A request that takes this long has hit a bug, not a slow disk. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Owns the indexing utility process from the main side.
 *
 * Kept deliberately thin: it starts the child, forwards typed commands, and
 * fans events out to whoever is listening. All the decisions live in the worker.
 */
export class IndexerClient {
  private child: UtilityProcess | null = null
  private readonly listeners = new Set<EventListener>()
  private readonly pending = new Map<string, PendingRequest>()
  private modelReady = false

  get isRunning(): boolean {
    return this.child !== null
  }

  get isModelReady(): boolean {
    return this.modelReady
  }

  start(): void {
    if (this.child) return

    // out/main/ and out/worker/ are siblings, in dev and inside the asar alike.
    const workerPath = join(__dirname, '../worker/index.mjs')

    this.child = utilityProcess.fork(workerPath, [], {
      // Surfaces the worker's stdout/stderr instead of letting it vanish.
      stdio: 'pipe',
      serviceName: 'trove-indexer'
    })

    this.child.on('message', (event: WorkerEvent) => {
      if (event.type === 'model-ready') this.modelReady = true

      // Some commands are request/response over this one-way event stream, so
      // they are correlated by request id and settled before general fan-out.
      if (event.type === 'search-results' || event.type === 'stats') {
        this.settle(event.requestId, (pending) => pending.resolve(event))
      } else if (event.type === 'error' && event.requestId !== null) {
        this.settle(event.requestId, (pending) => pending.reject(new Error(event.message)))
      }

      for (const listener of this.listeners) listener(event)
    })

    this.child.stderr?.on('data', (data: Buffer) => {
      console.error('[trove:worker]', data.toString().trimEnd())
    })

    this.child.stdout?.on('data', (data: Buffer) => {
      console.log('[trove:worker]', data.toString().trimEnd())
    })

    this.child.on('exit', (code) => {
      console.warn(`[trove] indexing worker exited with ${code}`)
      this.child = null
      this.modelReady = false
      // Nothing will ever answer these now.
      for (const requestId of [...this.pending.keys()]) {
        this.settle(requestId, (pending) => pending.reject(new Error('Indexing worker stopped')))
      }
    })

    this.send({
      type: 'init',
      dbPath: join(app.getPath('userData'), 'trove.db'),
      // userData is writable in a packaged install; the app directory is not.
      modelCacheDir: join(app.getPath('userData'), 'models')
    })
  }

  /** @returns the request id, for correlating progress and cancellation. */
  index(folders: string[]): string {
    const requestId = randomUUID()
    this.send({ type: 'index', requestId, folders })
    return requestId
  }

  cancel(requestId: string): void {
    this.send({ type: 'cancel', requestId })
  }

  search(query: string, limit?: number): Promise<SearchResultsEvent> {
    return this.request<SearchResultsEvent>((requestId) => ({
      type: 'search',
      requestId,
      query,
      limit
    }))
  }

  stats(): Promise<StatsEvent> {
    return this.request<StatsEvent>((requestId) => ({ type: 'stats', requestId }))
  }

  removeFolder(folder: string): Promise<StatsEvent> {
    return this.request<StatsEvent>((requestId) => ({ type: 'remove-folder', requestId, folder }))
  }

  /** Discards every stored vector and re-embeds from scratch. */
  rebuild(folders: string[]): string {
    const requestId = randomUUID()
    this.send({ type: 'rebuild', requestId, folders })
    return requestId
  }

  /** Replaces the worker's live-watch list. */
  watch(folders: string[]): void {
    this.send({ type: 'watch', folders })
  }

  private request<T extends ReplyEvent>(build: (requestId: string) => WorkerCommand): Promise<T> {
    if (!this.child) return Promise.reject(new Error('Indexing worker is not running'))

    const requestId = randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Worker request timed out'))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(requestId, {
        resolve: (event) => resolve(event as T),
        reject,
        timer
      })
      this.send(build(requestId))
    })
  }

  private settle(requestId: string, settle: (pending: PendingRequest) => void): void {
    const pending = this.pending.get(requestId)
    if (!pending) return

    clearTimeout(pending.timer)
    this.pending.delete(requestId)
    settle(pending)
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stop(): void {
    if (!this.child) return
    this.send({ type: 'shutdown' })
    // The worker exits itself on shutdown; kill() is the backstop if it hangs.
    const child = this.child
    setTimeout(() => child.kill(), 2000)
    this.child = null
  }

  private send(command: WorkerCommand): void {
    this.child?.postMessage(command)
  }
}

export const indexer = new IndexerClient()
