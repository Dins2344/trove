import { join } from 'node:path'
import { BrowserWindow, screen, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { IpcChannel } from '../../shared/ipc'
import { APP_ORIGIN } from '../protocol'

const OVERLAY_WIDTH = 720
/** Just the input bar for now; results grow the window via `overlay:resize`. */
const INITIAL_HEIGHT = 92
/** Sits a little above true centre -- matches where Spotlight/Alfred land. */
const VERTICAL_ANCHOR = 0.22

let overlayWindow: BrowserWindow | null = null

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow
}

export function createOverlayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: INITIAL_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Keeps the renderer warm while hidden so the first hotkey press paints
    // instantly instead of showing an empty frame.
    paintWhenInitiallyHidden: true,
    backgroundColor: '#00000000',
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

  // 'screen-saver' is the level that actually wins against fullscreen apps on
  // Windows; plain alwaysOnTop loses to them.
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  window.on('blur', () => {
    // During development the devtools steal focus constantly, which would make
    // the overlay impossible to inspect.
    if (window.webContents.isDevToolsOpened()) return
    hideOverlay()
  })

  // The window is reused for the whole app lifetime -- closing it should hide
  // it, not destroy it. Only a real quit gets through.
  window.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    hideOverlay()
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (is.dev && devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadURL(`${APP_ORIGIN}/index.html`)
  }

  overlayWindow = window
  return window
}

let isQuitting = false

/** Lets the overlay's close handler know a real quit is in progress. */
export function markQuitting(): void {
  isQuitting = true
}

/**
 * Centres the overlay on whichever display currently holds the cursor, rather
 * than the primary display -- on a multi-monitor desk those are rarely the same.
 */
function positionOnActiveDisplay(window: BrowserWindow): void {
  const cursor = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursor)
  const [width, height] = window.getSize()

  window.setBounds({
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height * VERTICAL_ANCHOR),
    width,
    height
  })
}

export function showOverlay(): void {
  const window = overlayWindow ?? createOverlayWindow()

  positionOnActiveDisplay(window)
  window.show()
  window.focus()
  window.webContents.send(IpcChannel.OverlayShown)
}

export function hideOverlay(): void {
  if (!overlayWindow || !overlayWindow.isVisible()) return
  overlayWindow.hide()
}

export function toggleOverlay(): void {
  if (overlayWindow?.isVisible()) {
    hideOverlay()
  } else {
    showOverlay()
  }
}

/** Grows/shrinks the overlay to fit its content, keeping its top edge fixed. */
export function resizeOverlay(height: number): void {
  if (!overlayWindow) return

  const bounds = overlayWindow.getBounds()
  const clamped = Math.max(INITIAL_HEIGHT, Math.min(Math.round(height), 720))
  if (clamped === bounds.height) return

  overlayWindow.setBounds({ ...bounds, height: clamped })
}
