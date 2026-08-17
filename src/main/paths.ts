import { join } from 'node:path'
import { app } from 'electron'

/**
 * Resolves a file inside `resources/`.
 *
 * In dev the bundled main process lives at `out/main/`, so the project's
 * `resources/` sits two levels up. When packaged, electron-builder copies that
 * folder to `process.resourcesPath`.
 */
export function resourcePath(...segments: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')
  return join(base, ...segments)
}
