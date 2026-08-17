import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { is } from '@electron-toolkit/utils'
import { APP_ORIGIN } from '../protocol'
import { resourcePath } from '../paths'

let settingsWindow: BrowserWindow | null = null

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow
}

/**
 * Opens (or focuses) the settings window.
 *
 * Shares the renderer bundle with the overlay and picks its view from the URL
 * hash. Two windows out of one bundle keeps the build simple, and the settings
 * view is small enough that a separate entry point would cost more than it
 * saves.
 */
export function openSettingsWindow(): BrowserWindow {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return settingsWindow
  }

  const window = new BrowserWindow({
    width: 760,
    height: 640,
    minWidth: 560,
    minHeight: 460,
    show: false,
    title: 'Trove Settings',
    icon: resourcePath('icons', 'icon.png'),
    backgroundColor: '#1c1c1e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    settingsWindow = null
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devServerUrl) {
    void window.loadURL(`${devServerUrl}#/settings`)
  } else {
    void window.loadURL(`${APP_ORIGIN}/index.html#/settings`)
  }

  settingsWindow = window
  return window
}
