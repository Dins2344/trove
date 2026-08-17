import { useCallback, useEffect, useState } from 'react'
import { HOTKEY_CHOICES, type IndexSummary, type Settings as SettingsData } from '../../shared/settings'
import type { WorkerEvent } from '../../shared/worker-protocol'
import { toStatus, type Status } from './StatusBar'

export function Settings(): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [stats, setStats] = useState<IndexSummary | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null)

  const refreshStats = useCallback(async () => {
    try {
      setStats(await window.trove.index.stats())
    } catch {
      // The worker may still be starting; the next event will refresh this.
    }
  }, [])

  useEffect(() => {
    void window.trove.settings.get().then(setSettings)
    void refreshStats()
  }, [refreshStats])

  useEffect(() => {
    return window.trove.index.onProgress((event: WorkerEvent) => {
      const next = toStatus(event)
      if (next) setStatus(next)

      if (event.type === 'done' || event.type === 'error') {
        setBusyRequestId(null)
        void refreshStats()
      }
      if (event.type === 'stats') {
        setStats({
          files: event.files,
          chunks: event.chunks,
          embeddedChunks: event.embeddedChunks
        })
      }
    })
  }, [refreshStats])

  const patch = useCallback(async (update: Partial<SettingsData>) => {
    setSettings(await window.trove.settings.update(update))
  }, [])

  const addFolder = useCallback(async () => {
    const result = await window.trove.index.chooseFolder()
    if (!result) return

    setBusyRequestId(result.requestId)
    setSettings(await window.trove.settings.get())
  }, [])

  const removeFolder = useCallback(
    async (folder: string) => {
      const summary = await window.trove.index.removeFolder(folder)
      if (summary) setStats(summary)
      setSettings(await window.trove.settings.get())
    },
    []
  )

  if (!settings) {
    return <div className="settings settings--loading">Loading…</div>
  }

  const onboarding = !settings.onboarded
  const hasFolders = settings.folders.length > 0

  return (
    <div className="settings">
      {onboarding && (
        <section className="panel panel--welcome">
          <h1>Welcome to Trove</h1>
          <p>
            Trove searches your files by <strong>meaning</strong>, not just keywords — so
            &ldquo;how do I get paid&rdquo; can find a document titled <em>Invoicing Procedure</em>.
          </p>
          <p className="muted">
            Everything runs on this machine. No account, no API key, and nothing is uploaded.
            The first run downloads a ~25MB language model, once.
          </p>
          <ol className="steps">
            <li className={hasFolders ? 'step step--done' : 'step step--active'}>
              Choose a folder to index
            </li>
            <li className={stats && stats.embeddedChunks > 0 ? 'step step--done' : 'step'}>
              Wait for the first index to finish
            </li>
            <li className="step">
              Press <kbd>{settings.hotkey}</kbd> anywhere to search
            </li>
          </ol>
          {hasFolders && stats && stats.embeddedChunks > 0 && (
            <button
              className="primary-button"
              type="button"
              onClick={() => void patch({ onboarded: true })}
            >
              Finish setup
            </button>
          )}
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Folders</h2>
          <button className="primary-button" type="button" onClick={() => void addFolder()}>
            Add folder
          </button>
        </div>

        {settings.folders.length === 0 ? (
          <p className="muted">No folders yet. Add one to start building your index.</p>
        ) : (
          <ul className="folder-list">
            {settings.folders.map((folder) => (
              <li key={folder} className="folder">
                <span className="folder-path" title={folder}>
                  {folder}
                </span>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => void removeFolder(folder)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h2>Index</h2>
        <dl className="stats">
          <div>
            <dt>Files</dt>
            <dd>{stats ? stats.files.toLocaleString() : '—'}</dd>
          </div>
          <div>
            <dt>Passages</dt>
            <dd>{stats ? stats.chunks.toLocaleString() : '—'}</dd>
          </div>
          <div>
            <dt>Searchable by meaning</dt>
            <dd>{stats ? stats.embeddedChunks.toLocaleString() : '—'}</dd>
          </div>
        </dl>

        {status && (
          <div className={`inline-status ${status.tone === 'error' ? 'inline-status--error' : ''}`}>
            {status.busy && <span className="spinner" aria-hidden="true" />}
            <span>{status.text}</span>
            {status.busy && busyRequestId && (
              <button
                className="ghost-button"
                type="button"
                onClick={() => window.trove.index.cancel(busyRequestId)}
              >
                Cancel
              </button>
            )}
          </div>
        )}

        <div className="button-row">
          <button
            className="ghost-button"
            type="button"
            disabled={!hasFolders}
            onClick={() => void window.trove.index.start().then(setBusyRequestId)}
          >
            Scan for changes
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={!hasFolders}
            onClick={() => void window.trove.index.rebuild().then(setBusyRequestId)}
          >
            Rebuild from scratch
          </button>
        </div>
        <p className="muted small">
          Trove watches these folders and picks up changes automatically. Rebuilding is only
          needed if results look wrong.
        </p>
      </section>

      <section className="panel">
        <h2>Shortcut</h2>
        <label className="field">
          <span>Open search with</span>
          <select
            value={settings.hotkey}
            onChange={(event) => void patch({ hotkey: event.target.value })}
          >
            {HOTKEY_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          If another application already owns the combination you pick, Trove falls back to the
          next available one and shows it in the tray menu.
        </p>
      </section>
    </div>
  )
}
