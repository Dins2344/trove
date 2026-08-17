import { globalShortcut } from 'electron'

/**
 * Tried in order. `Alt+Space` is the one users expect, but it opens the window
 * menu in some apps and other launchers grab it, so we degrade rather than
 * silently ending up with no hotkey at all.
 */
const CANDIDATE_ACCELERATORS = ['Alt+Space', 'Alt+Shift+Space', 'Control+Alt+Space'] as const

/**
 * Registers the user's preferred hotkey, falling back through the candidates
 * if it is unavailable.
 *
 * Any previously registered accelerator is released first, so this doubles as
 * the "apply a changed setting" path.
 *
 * @returns the accelerator that actually registered, or null if every candidate
 * was already taken by another application.
 */
export function registerSearchHotkey(preferred: string | null, onTrigger: () => void): string | null {
  globalShortcut.unregisterAll()

  const candidates = preferred
    ? [preferred, ...CANDIDATE_ACCELERATORS.filter((entry) => entry !== preferred)]
    : [...CANDIDATE_ACCELERATORS]

  for (const accelerator of candidates) {
    try {
      if (globalShortcut.isRegistered(accelerator)) continue
      if (globalShortcut.register(accelerator, onTrigger)) return accelerator
    } catch {
      // An accelerator string Electron cannot parse -- try the next one rather
      // than leaving the app with no hotkey at all.
    }
  }
  return null
}

export function unregisterShortcuts(): void {
  globalShortcut.unregisterAll()
}
