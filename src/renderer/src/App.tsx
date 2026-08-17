import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { IndexSummary } from '../../shared/settings'
import type { SearchHit, WorkerEvent } from '../../shared/worker-protocol'
import { ResultList } from './ResultList'
import { StatusBar, toStatus, type Status } from './StatusBar'

/** Long enough to skip most intermediate keystrokes, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 120

export function App(): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [selected, setSelected] = useState(0)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [indexed, setIndexed] = useState<IndexSummary | null>(null)

  const inputRef = useRef<HTMLInputElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  /** Guards against an earlier, slower search overwriting a later one. */
  const latestSearch = useRef(0)

  // The window is hidden rather than destroyed between invocations, so focus
  // has to be re-taken every time it is shown.
  useEffect(() => {
    const onShown = (): void => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }

    onShown()
    return window.trove.overlay.onShown(onShown)
  }, [])

  const refreshStats = useCallback(async () => {
    try {
      setIndexed(await window.trove.index.stats())
    } catch {
      // Worker still starting; a later event will refresh this.
    }
  }, [])

  useEffect(() => {
    void refreshStats()
  }, [refreshStats])

  useEffect(() => {
    return window.trove.index.onProgress((event: WorkerEvent) => {
      const next = toStatus(event)
      if (next) setStatus(next)
      if (event.type === 'done' || event.type === 'error') {
        setRequestId(null)
        void refreshStats()
      }
      if (event.type === 'model-ready') void refreshStats()
    })
  }, [refreshStats])

  // Debounced search-as-you-type.
  useEffect(() => {
    const trimmed = query.trim()

    if (trimmed.length === 0) {
      latestSearch.current++
      setHits([])
      setElapsedMs(null)
      return
    }

    const token = ++latestSearch.current
    const timer = setTimeout(async () => {
      try {
        const response = await window.trove.search.query(trimmed, 20)
        // A slower earlier request must not clobber a newer result set.
        if (token !== latestSearch.current) return
        setHits(response.hits)
        setElapsedMs(response.elapsedMs)
        setSelected(0)
      } catch {
        if (token !== latestSearch.current) return
        setHits([])
      }
    }, SEARCH_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query])

  // Size the window to whatever the content actually is, rather than trying to
  // predict it from result counts and CSS.
  useLayoutEffect(() => {
    const element = contentRef.current
    if (!element) return

    const observer = new ResizeObserver(() => {
      window.trove.overlay.resize(element.offsetHeight + 24)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const openSelected = useCallback(
    (reveal: boolean) => {
      const hit = hits[selected]
      if (!hit) return

      void (reveal
        ? window.trove.search.reveal(hit.filePath)
        : window.trove.search.open(hit.filePath))
      window.trove.overlay.hide()
    },
    [hits, selected]
  )

  const chooseFolder = useCallback(async (): Promise<void> => {
    const result = await window.trove.index.chooseFolder()
    if (result) setRequestId(result.requestId)
  }, [])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        window.trove.overlay.hide()
        break

      case 'ArrowDown':
        event.preventDefault()
        setSelected((current) => Math.min(current + 1, Math.max(0, hits.length - 1)))
        break

      case 'ArrowUp':
        event.preventDefault()
        setSelected((current) => Math.max(current - 1, 0))
        break

      case 'Enter':
        event.preventDefault()
        openSelected(event.ctrlKey || event.metaKey)
        break

      case 'o':
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault()
          void chooseFolder()
        }
        break
    }
  }

  const showResults = query.trim().length > 0

  return (
    <div className="overlay" ref={contentRef}>
      <div className="search-card">
        <SearchIcon />
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder="Search your files by meaning…"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        {elapsedMs !== null && showResults && (
          <span className="timing">{elapsedMs}ms</span>
        )}
        <button className="ghost-button" type="button" onClick={() => void chooseFolder()}>
          Add folder
        </button>
      </div>

      {showResults && (
        <ResultList
          hits={hits}
          query={query}
          selected={selected}
          hasIndex={(indexed?.chunks ?? 0) > 0}
          semanticReady={(indexed?.embeddedChunks ?? 0) > 0}
          onSelect={setSelected}
          onActivate={() => openSelected(false)}
          onAddFolder={() => void chooseFolder()}
        />
      )}

      {status && (
        <StatusBar
          status={status}
          requestId={requestId}
          onCancel={(id) => window.trove.index.cancel(id)}
        />
      )}
    </div>
  )
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg
      className="search-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </svg>
  )
}
