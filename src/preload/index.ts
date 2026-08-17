import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel } from '../shared/ipc'
import type { IndexSummary, Settings } from '../shared/settings'
import type { SearchHit, WorkerEvent } from '../shared/worker-protocol'

export interface SearchResponse {
  hits: SearchHit[]
  elapsedMs: number
  semanticAvailable: boolean
}

/**
 * The entire surface the renderer gets. Every function here is a deliberate
 * hole in the isolation boundary, so the list stays short and specific -- no
 * generic `invoke(channel, ...args)` escape hatch, which would hand the
 * renderer the whole IPC surface and undo the point of contextIsolation.
 */
const api = {
  overlay: {
    hide: (): void => ipcRenderer.send(IpcChannel.OverlayHide),
    resize: (height: number): void => ipcRenderer.send(IpcChannel.OverlayResize, height),
    /**
     * @returns an unsubscribe function -- React effects need one, and without
     * it every hotkey press would stack another listener.
     */
    onShown: (callback: () => void): (() => void) => {
      // The IpcRendererEvent is deliberately swallowed: handing it across would
      // leak `sender` into renderer-land.
      const listener = (): void => callback()
      ipcRenderer.on(IpcChannel.OverlayShown, listener)
      return () => {
        ipcRenderer.off(IpcChannel.OverlayShown, listener)
      }
    }
  },
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke(IpcChannel.AppGetVersion)
  },
  search: {
    query: (text: string, limit?: number): Promise<SearchResponse> =>
      ipcRenderer.invoke(IpcChannel.SearchQuery, text, limit),
    open: (filePath: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.ResultOpen, filePath),
    reveal: (filePath: string): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannel.ResultReveal, filePath)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IpcChannel.SettingsGet),
    update: (patch: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke(IpcChannel.SettingsUpdate, patch),
    open: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.SettingsOpen)
  },
  index: {
    chooseFolder: (): Promise<{ requestId: string; folder: string } | null> =>
      ipcRenderer.invoke(IpcChannel.IndexChooseFolder),
    removeFolder: (folder: string): Promise<IndexSummary | null> =>
      ipcRenderer.invoke(IpcChannel.IndexRemoveFolder, folder),
    stats: (): Promise<IndexSummary> => ipcRenderer.invoke(IpcChannel.IndexStats),
    start: (): Promise<string | null> => ipcRenderer.invoke(IpcChannel.IndexStart),
    rebuild: (): Promise<string | null> => ipcRenderer.invoke(IpcChannel.IndexRebuild),
    cancel: (requestId: string): void => ipcRenderer.send(IpcChannel.IndexCancel, requestId),
    onProgress: (callback: (event: WorkerEvent) => void): (() => void) => {
      const listener = (_event: unknown, payload: WorkerEvent): void => callback(payload)
      ipcRenderer.on(IpcChannel.IndexProgress, listener)
      return () => {
        ipcRenderer.off(IpcChannel.IndexProgress, listener)
      }
    }
  }
}

export type TroveApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('trove', api)
  } catch (error) {
    console.error('[trove] failed to expose preload API', error)
  }
} else {
  // Should be unreachable -- contextIsolation is forced on for every window.
  throw new Error('contextIsolation is disabled; refusing to expose the API')
}
