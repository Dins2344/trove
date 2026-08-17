import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'

/**
 * Production renderer is served from `app://local/` rather than `file://`.
 *
 * Two reasons, both load-bearing:
 *  1. `webRequest.onHeadersReceived` does not fire reliably for `file://`, so a
 *     header-based CSP would silently never apply to the packaged app -- the
 *     exact situation where it matters most.
 *  2. `file://` pages are treated as an opaque origin, which makes `'self'`
 *     meaningless. A real scheme gives the CSP something to bind to.
 */
export const APP_SCHEME = 'app'
export const APP_ORIGIN = `${APP_SCHEME}://local`

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ])
}

/** Must run after `app.whenReady()`. */
export function serveRenderer(): void {
  const root = normalize(join(__dirname, '../renderer'))

  protocol.handle(APP_SCHEME, async (request) => {
    const { pathname } = new URL(request.url)
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
    const target = normalize(join(root, relative))

    // `..` segments in the request must never escape the bundled renderer.
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response('Forbidden', { status: 403 })
    }

    return net.fetch(pathToFileURL(target).toString())
  })
}
