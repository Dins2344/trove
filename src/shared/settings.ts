export interface Settings {
  /** Absolute paths Trove indexes and watches. */
  folders: string[]
  /** Electron accelerator for the search overlay. */
  hotkey: string
  /** False until the user has completed first-run setup. */
  onboarded: boolean
}

/**
 * Offered as a fixed list rather than free-form capture.
 *
 * A key-capture widget has to reason about modifiers, dead keys and layouts,
 * and can still hand back an accelerator the OS refuses to register. A short
 * list of combinations that are actually available on Windows is more useful
 * than a general solution that fails at the last step.
 */
export const HOTKEY_CHOICES = [
  'Alt+Space',
  'Alt+Shift+Space',
  'Control+Alt+Space',
  'Control+Shift+Space',
  'Control+Shift+F',
  'Alt+Shift+F'
] as const

export const DEFAULT_SETTINGS: Settings = {
  folders: [],
  hotkey: 'Alt+Space',
  onboarded: false
}

export interface IndexSummary {
  files: number
  chunks: number
  embeddedChunks: number
}
