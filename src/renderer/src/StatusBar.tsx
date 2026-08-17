import type { WorkerEvent } from '../../shared/worker-protocol'

export interface Status {
  text: string
  busy: boolean
  tone: 'normal' | 'error'
}

/** Turns a worker event into a single line a person can read at a glance. */
export function toStatus(event: WorkerEvent): Status | null {
  switch (event.type) {
    case 'model-download':
      return {
        text:
          event.percent === null
            ? `Downloading language model… ${(event.loaded / 1e6).toFixed(1)}MB`
            : `Downloading language model… ${event.percent}%`,
        busy: true,
        tone: 'normal'
      }

    case 'model-ready':
      return { text: 'Ready', busy: false, tone: 'normal' }

    case 'progress': {
      const { counters, phase } = event
      if (phase === 'embedding') {
        const total = counters.chunksEmbedded + counters.chunksPending
        return {
          text: `Embedding ${counters.chunksEmbedded.toLocaleString()} / ${total.toLocaleString()} passages`,
          busy: true,
          tone: 'normal'
        }
      }
      if (phase === 'pruning') {
        return { text: 'Removing deleted files…', busy: true, tone: 'normal' }
      }
      return {
        text: `Scanning ${counters.filesSeen.toLocaleString()} files · ${counters.chunksWritten.toLocaleString()} passages`,
        busy: true,
        tone: 'normal'
      }
    }

    case 'done': {
      const seconds = (event.elapsedMs / 1000).toFixed(1)
      if (event.cancelled) {
        return { text: `Cancelled after ${seconds}s`, busy: false, tone: 'normal' }
      }
      return {
        text: `Indexed ${event.counters.filesIndexed.toLocaleString()} files · ${event.counters.chunksEmbedded.toLocaleString()} vectors in ${seconds}s`,
        busy: false,
        tone: 'normal'
      }
    }

    case 'error':
      return { text: event.message, busy: false, tone: 'error' }

    default:
      return null
  }
}

interface StatusBarProps {
  status: Status
  requestId: string | null
  onCancel: (requestId: string) => void
}

export function StatusBar({ status, requestId, onCancel }: StatusBarProps): React.JSX.Element {
  return (
    <div className={`status-bar ${status.tone === 'error' ? 'status-bar--error' : ''}`}>
      {status.busy && <span className="spinner" aria-hidden="true" />}
      <span className="status-text">{status.text}</span>
      {status.busy && requestId && (
        <button className="ghost-button" type="button" onClick={() => onCancel(requestId)}>
          Cancel
        </button>
      )}
    </div>
  )
}
