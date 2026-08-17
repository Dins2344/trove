import { useEffect, useRef } from 'react'
import type { SearchHit } from '../../shared/worker-protocol'

interface ResultListProps {
  hits: SearchHit[]
  query: string
  selected: number
  /** False when nothing has been indexed yet, which needs different advice. */
  hasIndex: boolean
  /** False while embeddings are still being generated. */
  semanticReady: boolean
  onSelect: (index: number) => void
  onActivate: () => void
  onAddFolder: () => void
}

export function ResultList({
  hits,
  query,
  selected,
  hasIndex,
  semanticReady,
  onSelect,
  onActivate,
  onAddFolder
}: ResultListProps): React.JSX.Element {
  const selectedRef = useRef<HTMLLIElement>(null)

  // Keyboard navigation has to drag the viewport along with it.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  if (hits.length === 0) {
    // "No results" and "you have not indexed anything" need entirely different
    // advice; showing one message for both leaves a new user stuck.
    return (
      <div className="results results--empty">
        {hasIndex ? (
          <>
            <div>
              No matches for <strong>{query.trim()}</strong>
            </div>
            {!semanticReady && (
              <div className="empty-hint">
                Still building the meaning index — try again shortly.
              </div>
            )}
          </>
        ) : (
          <>
            <div>Nothing indexed yet.</div>
            <button className="ghost-button" type="button" onClick={onAddFolder}>
              Choose a folder
            </button>
          </>
        )}
      </div>
    )
  }

  return (
    <ul className="results" role="listbox">
      {hits.map((hit, index) => (
        <li
          key={hit.chunkId}
          ref={index === selected ? selectedRef : undefined}
          role="option"
          aria-selected={index === selected}
          className={`result ${index === selected ? 'result--selected' : ''}`}
          onMouseMove={() => onSelect(index)}
          onClick={onActivate}
        >
          <div className="result-head">
            <span className="result-name">{hit.fileName}</span>
            {hit.headingPath && <span className="result-crumb">{hit.headingPath}</span>}
            <span className="result-badges">
              {/* Which leg found this: useful while tuning, and quietly
                  informative about why a result is here at all. */}
              {hit.matchedKeyword && <span className="badge badge--keyword">text</span>}
              {hit.matchedSemantic && <span className="badge badge--semantic">meaning</span>}
            </span>
          </div>
          <div className="result-snippet">{highlight(hit.text, query)}</div>
          <div className="result-meta">
            {hit.filePath} · lines {hit.startLine}–{hit.endLine}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Escapes a token so it can be dropped into a RegExp safely. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Marks query terms inside a snippet.
 *
 * Only the keyword leg's terms can be highlighted -- a semantic match has no
 * literal overlap to point at, which is precisely what makes it useful.
 */
function highlight(text: string, query: string): React.ReactNode {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 1)

  if (terms.length === 0) return text

  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  // split() with a capturing group puts the matches at the odd indices. Using
  // pattern.test() here instead would be wrong twice over: a /g regex carries
  // lastIndex between calls, so it alternates true/false on identical input.
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? <mark key={index}>{part}</mark> : part
  )
}
