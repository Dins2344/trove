import { app } from 'electron'
import electronUpdater from 'electron-updater'

/** Re-check roughly every six hours for a long-running tray app. */
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

let timer: NodeJS.Timeout | null = null

/**
 * Auto-update against GitHub Releases.
 *
 * Every failure path here is non-fatal on purpose. Update checks fail for
 * entirely ordinary reasons -- no network, no release published yet, the
 * `publish` block still holding its placeholder owner -- and none of them are a
 * reason to interrupt someone searching their own files offline.
 */
export function initAutoUpdater(): void {
  // In development there is no update feed and no installer to replace.
  if (!app.isPackaged) return

  // electron-updater is CommonJS with a default export; destructuring the
  // namespace is the interop-safe form from a bundled main process.
  const { autoUpdater } = electronUpdater

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (error) => {
    console.warn('[trove] update check failed:', error.message)
  })
  autoUpdater.on('update-available', (info) => {
    console.log(`[trove] update available: ${info.version}`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    // Installed on quit rather than forced now -- this is a background app and
    // restarting it mid-search would be rude.
    console.log(`[trove] update ${info.version} staged for next restart`)
  })

  const check = (): void => {
    void autoUpdater.checkForUpdates().catch((error: Error) => {
      console.warn('[trove] update check failed:', error.message)
    })
  }

  check()
  timer = setInterval(check, UPDATE_INTERVAL_MS)
}

export function stopAutoUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
}
