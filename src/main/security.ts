import { app, session, shell } from 'electron'
import { is } from '@electron-toolkit/utils'
import { APP_ORIGIN } from './protocol'

/**
 * Vite's dev server needs inline/eval script execution and a websocket back to
 * localhost for HMR. Production gets none of that.
 */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*"
].join('; ')

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // The renderer never talks to the network. All model/file work happens in the
  // utility process, so locking this down costs us nothing.
  "connect-src 'none'"
].join('; ')

/**
 * Applies process-wide security hardening. Called once, before any window
 * exists, so no window can be created outside these rules.
 */
export function applySecurityPolicy(): void {
  const csp = is.dev ? DEV_CSP : PROD_CSP

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  // Trove needs no web permissions whatsoever -- camera, geolocation,
  // notifications, clipboard read, all of it stays denied.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  app.on('web-contents-created', (_event, contents) => {
    // Nothing in this app should ever open a second window. If a link wants to
    // go somewhere, it goes to the user's real browser instead.
    contents.setWindowOpenHandler(({ url }) => {
      void openExternalIfSafe(url)
      return { action: 'deny' }
    })

    // Pin the renderer to its own origin. Anything else is a navigation we
    // didn't intend, so cancel it and hand it to the browser.
    contents.on('will-navigate', (event, url) => {
      // `'\0'` is a sentinel that no URL can start with, so a missing dev-server
      // env var fails closed rather than matching everything.
      const devServerUrl = is.dev ? (process.env['ELECTRON_RENDERER_URL'] ?? '\0') : '\0'
      if (url.startsWith(devServerUrl) || url.startsWith(APP_ORIGIN)) return

      event.preventDefault()
      void openExternalIfSafe(url)
    })

    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
  })
}

/** Only ever hand http(s) URLs to the OS -- never file:, and never anything exotic. */
async function openExternalIfSafe(rawUrl: string): Promise<void> {
  try {
    const { protocol } = new URL(rawUrl)
    if (protocol === 'https:' || protocol === 'http:') {
      await shell.openExternal(rawUrl)
    }
  } catch {
    // Malformed URL -- nothing to open.
  }
}
