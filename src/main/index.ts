import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import { IpcChannel } from '../shared/ipc'
import { applySecurityPolicy } from './security'
import { indexConfiguredFolders, registerIpcHandlers } from './ipc'
import { registerAppScheme, serveRenderer } from './protocol'
import { getSettings, onSettingsChanged } from './settings'
import { registerSearchHotkey, unregisterShortcuts } from './shortcuts'
import { createTray, destroyTray, updateTrayHotkey } from './tray'
import { initAutoUpdater, stopAutoUpdater } from './updater'
import {
  createOverlayWindow,
  getOverlayWindow,
  markQuitting,
  showOverlay,
  toggleOverlay
} from './windows/overlay'
import { getSettingsWindow, openSettingsWindow } from './windows/settings'
import { indexer } from './worker-client'

// Privileged schemes must be declared before the app is ready, so this runs at
// module scope rather than inside onReady().
registerAppScheme()

// A launcher must be a singleton: a second copy would fight over the global
// hotkey and open a competing overlay. Hand the activation to the running
// instance instead.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showOverlay()
  })

  void app.whenReady().then(onReady)
}

function onReady(): void {
  electronApp.setAppUserModelId('com.dinsondavis.trove')
  applySecurityPolicy()
  serveRenderer()

  createOverlayWindow()
  registerIpcHandlers()

  const settings = getSettings()

  // The worker downloads the model on first launch, so start it now rather than
  // making the user wait for it at their first search.
  indexer.start()
  indexer.onEvent((event) => {
    if (event.type === 'error') {
      console.error('[trove] worker error:', event.message)
    }

    // Both windows care: the overlay shows a status line, settings shows
    // progress and live counts.
    getOverlayWindow()?.webContents.send(IpcChannel.IndexProgress, event)
    getSettingsWindow()?.webContents.send(IpcChannel.IndexProgress, event)

    // Pick up where a previous session left off once the model is available.
    if (event.type === 'model-ready') {
      indexConfiguredFolders()
    }
  })

  let hotkey = registerSearchHotkey(settings.hotkey, toggleOverlay)
  reportHotkey(hotkey)

  createTray({
    onShowSearch: showOverlay,
    onOpenSettings: openSettingsWindow,
    onQuit: quit,
    hotkeyLabel: hotkey
  })

  // Applying a changed hotkey is the one setting that needs main to act.
  onSettingsChanged((next) => {
    if (next.hotkey === hotkey) return
    hotkey = registerSearchHotkey(next.hotkey, toggleOverlay)
    reportHotkey(hotkey)
    updateTrayHotkey(hotkey)
  })

  // First run: there is nothing to search yet, so send the user somewhere that
  // explains what to do rather than an empty search box.
  if (!settings.onboarded) {
    openSettingsWindow()
  }

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // macOS convention: clicking the dock icon reopens the UI.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlayWindow()
  })

  // Trove lives in the tray. Closing a window must never end the process --
  // that is the whole point of a background launcher.
  app.on('window-all-closed', () => {
    // Intentionally empty.
  })

  initAutoUpdater()

  app.on('will-quit', () => {
    unregisterShortcuts()
    destroyTray()
    stopAutoUpdater()
    indexer.stop()
  })
}

function reportHotkey(hotkey: string | null): void {
  if (hotkey === null) {
    console.warn('[trove] no global hotkey available; use the tray icon instead')
  } else {
    console.log(`[trove] search hotkey registered: ${hotkey}`)
  }
}

function quit(): void {
  markQuitting()
  app.quit()
}
