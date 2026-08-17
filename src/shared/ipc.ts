/**
 * Channel names shared between main and preload.
 *
 * Kept in one place so the preload allowlist and the main-process handlers can
 * never drift apart -- a mismatch there is the usual way an Electron app ends up
 * exposing a channel nobody meant to expose.
 */
export const IpcChannel = {
  /** renderer -> main, fire and forget */
  OverlayHide: 'overlay:hide',
  OverlayResize: 'overlay:resize',
  /** main -> renderer, fire and forget */
  OverlayShown: 'overlay:shown',
  /** renderer -> main, request/response */
  AppGetVersion: 'app:get-version',
  /** Opens a folder picker and starts indexing the chosen folder. */
  IndexChooseFolder: 'index:choose-folder',
  IndexCancel: 'index:cancel',
  /** main -> renderer: streamed worker progress. */
  IndexProgress: 'index:progress',
  SearchQuery: 'search:query',
  SettingsGet: 'settings:get',
  SettingsUpdate: 'settings:update',
  SettingsOpen: 'settings:open',
  IndexRemoveFolder: 'index:remove-folder',
  IndexStats: 'index:stats',
  IndexRebuild: 'index:rebuild',
  /** Re-scans every configured folder. */
  IndexStart: 'index:start',
  /** Opens a result in the OS default application. */
  ResultOpen: 'result:open',
  /** Reveals a result in Explorer/Finder. */
  ResultReveal: 'result:reveal'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]
