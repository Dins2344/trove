import { app, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { Settings } from '../shared/settings'
import { getSettings, updateSettings } from './settings'
import { getOverlayWindow, hideOverlay, resizeOverlay } from './windows/overlay'
import { getSettingsWindow, openSettingsWindow } from './windows/settings'
import { indexer } from './worker-client'

/**
 * Paths the renderer is currently allowed to ask main to open.
 *
 * The renderer supplies the path when the user activates a result, and a
 * compromised or buggy renderer must not be able to turn that into "open any
 * file on this machine". Only paths main itself has just returned from a search
 * are eligible.
 */
const openablePaths = new Set<string>()
/** Bounded so a long session cannot grow this without limit. */
const MAX_OPENABLE_PATHS = 500

function rememberOpenablePaths(paths: readonly string[]): void {
  for (const path of paths) {
    if (openablePaths.size >= MAX_OPENABLE_PATHS) {
      const oldest = openablePaths.values().next().value
      if (oldest !== undefined) openablePaths.delete(oldest)
    }
    openablePaths.add(path)
  }
}

/**
 * `contextIsolation` stops a compromised renderer reaching Node directly, but
 * it does not stop one window sending a channel meant for another. Every
 * handler checks the sender is one of ours.
 */
function isFromTrove(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const overlay = getOverlayWindow()
  const settings = getSettingsWindow()
  return (
    (overlay !== null && event.sender === overlay.webContents) ||
    (settings !== null && event.sender === settings.webContents)
  )
}

function requireTrove(event: IpcMainInvokeEvent): void {
  if (!isFromTrove(event)) throw new Error('Unauthorized sender')
}

/** Starts an index run over every configured folder. */
function indexConfiguredFolders(): string | null {
  const { folders } = getSettings()
  if (folders.length === 0) return null

  indexer.watch(folders)
  return indexer.index(folders)
}

export function registerIpcHandlers(): void {
  // ------------------------------------------------------------- overlay

  ipcMain.on(IpcChannel.OverlayHide, (event) => {
    if (!isFromTrove(event)) return
    hideOverlay()
  })

  ipcMain.on(IpcChannel.OverlayResize, (event, height: unknown) => {
    if (!isFromTrove(event)) return
    // Payload comes from the renderer, so it is untrusted regardless of types.
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return
    resizeOverlay(height)
  })

  ipcMain.handle(IpcChannel.AppGetVersion, (event) => {
    requireTrove(event)
    return app.getVersion()
  })

  // -------------------------------------------------------------- search

  ipcMain.handle(IpcChannel.SearchQuery, async (event, query: unknown, limit: unknown) => {
    requireTrove(event)
    if (typeof query !== 'string') return { hits: [], elapsedMs: 0, semanticAvailable: false }

    const response = await indexer.search(
      query,
      typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined
    )
    rememberOpenablePaths(response.hits.map((hit) => hit.filePath))

    return {
      hits: response.hits,
      elapsedMs: response.elapsedMs,
      semanticAvailable: response.semanticAvailable
    }
  })

  ipcMain.handle(IpcChannel.ResultOpen, async (event, filePath: unknown) => {
    requireTrove(event)
    if (typeof filePath !== 'string' || !openablePaths.has(filePath)) return false

    // Returns a non-empty string on failure rather than throwing.
    const error = await shell.openPath(filePath)
    return error === ''
  })

  ipcMain.handle(IpcChannel.ResultReveal, (event, filePath: unknown) => {
    requireTrove(event)
    if (typeof filePath !== 'string' || !openablePaths.has(filePath)) return false

    shell.showItemInFolder(filePath)
    return true
  })

  // ------------------------------------------------------------ settings

  ipcMain.handle(IpcChannel.SettingsGet, (event) => {
    requireTrove(event)
    return getSettings()
  })

  ipcMain.handle(IpcChannel.SettingsUpdate, (event, patch: unknown) => {
    requireTrove(event)
    if (typeof patch !== 'object' || patch === null) return getSettings()
    // updateSettings sanitises every field, so a malformed patch cannot corrupt
    // the stored settings.
    return updateSettings(patch as Partial<Settings>)
  })

  ipcMain.handle(IpcChannel.SettingsOpen, (event) => {
    requireTrove(event)
    openSettingsWindow()
    return true
  })

  // ------------------------------------------------------------- indexing

  ipcMain.handle(IpcChannel.IndexChooseFolder, async (event) => {
    requireTrove(event)

    const overlay = getOverlayWindow()
    // The overlay hides on blur and the modal steals focus, so without this the
    // picker would dismiss the window that opened it.
    const wasVisible = overlay?.isVisible() ?? false

    const result = await dialog.showOpenDialog({
      title: 'Choose a folder to index',
      properties: ['openDirectory']
    })

    if (wasVisible) overlay?.show()
    if (result.canceled || result.filePaths.length === 0) return null

    const folder = result.filePaths[0]
    const settings = updateSettings({
      folders: [...new Set([...getSettings().folders, folder])]
    })

    indexer.watch(settings.folders)
    return { requestId: indexer.index([folder]), folder }
  })

  ipcMain.handle(IpcChannel.IndexRemoveFolder, async (event, folder: unknown) => {
    requireTrove(event)
    if (typeof folder !== 'string') return null

    const settings = updateSettings({
      folders: getSettings().folders.filter((entry) => entry !== folder)
    })
    indexer.watch(settings.folders)

    // Drops the folder's files from the index so they stop appearing in results.
    const stats = await indexer.removeFolder(folder)
    return { files: stats.files, chunks: stats.chunks, embeddedChunks: stats.embeddedChunks }
  })

  ipcMain.handle(IpcChannel.IndexStats, async (event) => {
    requireTrove(event)
    const stats = await indexer.stats()
    return { files: stats.files, chunks: stats.chunks, embeddedChunks: stats.embeddedChunks }
  })

  ipcMain.handle(IpcChannel.IndexStart, (event) => {
    requireTrove(event)
    return indexConfiguredFolders()
  })

  ipcMain.handle(IpcChannel.IndexRebuild, (event) => {
    requireTrove(event)
    const { folders } = getSettings()
    if (folders.length === 0) return null

    indexer.watch(folders)
    return indexer.rebuild(folders)
  })

  ipcMain.on(IpcChannel.IndexCancel, (event, requestId: unknown) => {
    if (!isFromTrove(event)) return
    if (typeof requestId !== 'string') return
    indexer.cancel(requestId)
  })
}

export { indexConfiguredFolders }
