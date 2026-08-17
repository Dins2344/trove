import { Menu, Tray, app, nativeImage } from 'electron'
import { resourcePath } from './paths'

let tray: Tray | null = null
let options: TrayOptions | null = null

interface TrayOptions {
  onShowSearch: () => void
  onOpenSettings: () => void
  onQuit: () => void
  /** Rendered next to the menu item so the user can discover the hotkey. */
  hotkeyLabel: string | null
}

function buildMenu(config: TrayOptions): Menu {
  return Menu.buildFromTemplate([
    {
      label: config.hotkeyLabel ? `Open Search  (${config.hotkeyLabel})` : 'Open Search',
      click: config.onShowSearch
    },
    ...(config.hotkeyLabel
      ? []
      : [{ label: 'Hotkey unavailable - another app has it', enabled: false } as const]),
    { type: 'separator' as const },
    { label: 'Settings…', click: config.onOpenSettings },
    { type: 'separator' as const },
    { label: `Trove ${app.getVersion()}`, enabled: false },
    { type: 'separator' as const },
    { label: 'Quit Trove', click: config.onQuit }
  ])
}

export function createTray(config: TrayOptions): Tray {
  options = config

  const icon = nativeImage.createFromPath(resourcePath('icons', 'tray.png'))
  tray = new Tray(icon)

  tray.setToolTip('Trove - offline semantic search')
  tray.setContextMenu(buildMenu(config))
  // Left-clicking a tray icon should do the obvious thing on Windows.
  tray.on('click', config.onShowSearch)

  return tray
}

/** Keeps the menu's hotkey hint truthful after the user changes it. */
export function updateTrayHotkey(hotkeyLabel: string | null): void {
  if (!tray || !options) return

  options = { ...options, hotkeyLabel }
  tray.setContextMenu(buildMenu(options))
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  options = null
}
